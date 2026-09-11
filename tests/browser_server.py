"""Local server and deterministic fixtures for browser-smoke.mjs."""
import json
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))
import app
import make_sample


class BrowserTestHandler(app.Handler):
    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/browser/set-opened":
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
            app.set_opened(path)
            self._json({"ok": True, "name": app.opened["name"], "id": app.opened["id"]})
            return
        super().do_POST()


with tempfile.TemporaryDirectory(prefix="fast-pdf-browser-") as directory:
    long_file = Path(directory) / "long.pdf"
    make_sample.PAGES = [f"Page {i + 1}: search needle and history regression." for i in range(120)]
    long_file.write_bytes(make_sample.build())
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserTestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(
        json.dumps(
            {
                "port": httpd.server_port,
                "long": str(long_file),
                "small": str(ROOT / "samples/demo.pdf"),
            }
        ),
        flush=True,
    )
    try:
        threading.Event().wait()
    finally:
        httpd.shutdown()
