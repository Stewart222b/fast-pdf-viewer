from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import uuid
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

opened_lock = threading.Lock()
opened: dict[str, object] = {"path": None, "name": None, "id": None}
OPENED_PATH = re.compile(r"^/opened(?:/([0-9a-f]{32})\.pdf|\.pdf)$")


class ViewerHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        sys.stderr.write("[http] " + (format % args) + "\n")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/startup":
            with opened_lock:
                payload = {
                    "path": opened.get("path"),
                    "name": opened.get("name"),
                    "id": opened.get("id"),
                    "hasFile": bool(opened.get("path")),
                }
            self._json(payload)
            return
        opened_match = OPENED_PATH.match(parsed.path)
        if opened_match:
            self._serve_opened(opened_match.group(1))
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/open-path":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json({"ok": False, "error": "invalid json"}, 400)
                return
            path = payload.get("path")
            if not path or not Path(path).is_file():
                self._json({"ok": False, "error": "file not found"}, 400)
                return
            set_opened(path)
            with opened_lock:
                self._json({"ok": True, "name": opened["name"], "id": opened["id"]})
            return
        self.send_error(404)

    def do_HEAD(self) -> None:  # noqa: N802
        opened_match = OPENED_PATH.match(urlparse(self.path).path)
        if opened_match:
            self._serve_opened(opened_match.group(1), head_only=True)
        else:
            super().do_HEAD()

    def _serve_opened(self, path_id: str | None = None, head_only: bool = False) -> None:
        requested_id = path_id or parse_qs(urlparse(self.path).query).get("id", [None])[0]
        with opened_lock:
            path = opened.get("path")
            current_id = opened.get("id")
            if requested_id is not None and requested_id != current_id:
                self.send_error(409, "Document changed; reopen the PDF")
                return
        if not path:
            self.send_error(404, "No PDF opened")
            return
        file_path = Path(str(path))
        try:
            source = file_path.open("rb")
        except OSError:
            self.send_error(404, "PDF missing or unreadable")
            return
        with source:
            stat = os.fstat(source.fileno())
            size = stat.st_size
            etag = f'"{stat.st_mtime_ns:x}-{size:x}"'
            start, end, status = 0, size - 1, 200
            header = self.headers.get("Range", "")
            if self.headers.get("If-Range", etag) == etag:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
                if match and any(match.groups()):
                    first, last = match.groups()
                    if first:
                        start = int(first)
                        end = min(int(last), size - 1) if last else size - 1
                    else:
                        start = max(0, size - int(last))
                    if start >= size or start > end or (not first and int(last) == 0):
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    status = 206
            self.send_response(status)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(max(0, end - start + 1)))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header(
                "Content-Disposition",
                f"inline; filename=\"document.pdf\"; filename*=UTF-8''{quote(file_path.name, safe='')}",
            )
            self.end_headers()
            if head_only:
                return
            source.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = source.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # Expected when pdf.js cancels an obsolete range request.

    def _json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def set_opened(path: str | os.PathLike[str] | None) -> None:
    with opened_lock:
        if not path:
            opened["path"] = None
            opened["name"] = None
            opened["id"] = None
            return
        p = Path(path).resolve()
        opened["path"] = str(p)
        opened["name"] = p.name
        opened["id"] = uuid.uuid4().hex


def ensure_pdfjs() -> None:
    desktop = Path(__file__).resolve().parent
    if str(desktop) not in sys.path:
        sys.path.insert(0, str(desktop))
    from bootstrap_pdfjs import installed_valid, main as bootstrap

    if not installed_valid():
        bootstrap()


def start_server(port: int = 17831) -> ThreadingHTTPServer:
    mimetypes.add_type("application/javascript", ".mjs")
    mimetypes.add_type("application/wasm", ".wasm")
    httpd = bind_server(port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def bind_server(port: int) -> ViewerHTTPServer:
    if port == 0:
        return ViewerHTTPServer(("127.0.0.1", 0), Handler)
    errors: list[OSError] = []
    for candidate in range(port, port + 30):
        try:
            return ViewerHTTPServer(("127.0.0.1", candidate), Handler)
        except OSError as exc:
            errors.append(exc)
    raise OSError(f"无法监听 127.0.0.1:{port}-{port + 29}") from errors[-1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="速览 Fast PDF Viewer")
    parser.add_argument("pdf", nargs="?", help="要打开的 PDF 路径")
    parser.add_argument(
        "--browser",
        action="store_true",
        help="强制使用系统浏览器而不是桌面窗口",
    )
    return parser.parse_args()


class Bridge:
    def pick(self):
        import webview

        window = webview.windows[0]
        result = window.create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=("PDF (*.pdf)",),
        )
        if not result:
            return None
        path = result[0]
        set_opened(path)
        with opened_lock:
            return {"name": opened["name"], "id": opened["id"]}


def open_window(url: str, title: str) -> bool:
    try:
        import webview
    except ImportError:
        return False

    webview.create_window(
        title,
        url,
        js_api=Bridge(),
        width=1280,
        height=860,
        min_size=(900, 600),
        background_color="#12141A",
        text_select=True,
    )
    webview.start()
    return True


def main() -> None:
    args = parse_args()
    ensure_pdfjs()
    if args.pdf:
        set_opened(args.pdf)

    httpd = start_server()
    host, port = httpd.server_address
    url = f"http://{host}:{port}/"
    print(f"速览 running at {url}")

    if not args.browser:
        if open_window(url, "速览"):
            httpd.shutdown()
            return
        print("未安装 pywebview，改为打开浏览器。可运行: pip install -r requirements.txt")

    webbrowser.open(url)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
