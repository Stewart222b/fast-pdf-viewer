"""Test HTTP handler extensions shared by browser and benchmark servers."""
import json
from pathlib import Path
from urllib.parse import urlparse

import app


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
