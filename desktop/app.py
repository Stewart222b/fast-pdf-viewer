from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
VENDOR = WEB / "vendor" / "pdfjs"

opened_lock = threading.Lock()
opened: dict[str, object] = {"path": None, "name": None}


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
            self._json(
                {
                    "path": opened.get("path"),
                    "name": opened.get("name"),
                    "hasFile": bool(opened.get("path")),
                }
            )
            return
        if parsed.path == "/opened.pdf":
            self._serve_opened()
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
            self._json({"ok": True, "name": opened["name"]})
            return
        self.send_error(404)

    def _serve_opened(self) -> None:
        with opened_lock:
            path = opened.get("path")
        if not path:
            self.send_error(404, "No PDF opened")
            return
        file_path = Path(str(path))
        if not file_path.is_file():
            self.send_error(404, "PDF missing")
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition",
            f"inline; filename=\"document.pdf\"; filename*=UTF-8''{quote(file_path.name, safe='')}",
        )
        self.end_headers()
        self.wfile.write(data)

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
            return
        p = Path(path).resolve()
        opened["path"] = str(p)
        opened["name"] = p.name


def ensure_pdfjs() -> None:
    marker = VENDOR / "VERSION"
    if marker.exists() and (VENDOR / "build" / "pdf.mjs").exists():
        return
    from bootstrap_pdfjs import main as bootstrap

    bootstrap()


def start_server(port: int = 17831) -> ThreadingHTTPServer:
    mimetypes.add_type("application/javascript", ".mjs")
    mimetypes.add_type("application/wasm", ".wasm")
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


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
        return {"name": Path(path).name}


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
