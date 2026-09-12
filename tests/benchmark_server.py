"""Serve viewer and multi-size synthetic PDFs for render-benchmark.mjs."""
import json
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))
sys.path.insert(0, str(ROOT / "tests"))
import app
import make_sample
from browser_handler import BrowserTestHandler


def write_pdf(path: Path, page_count: int, repeat: str) -> None:
    make_sample.PAGES = [
        f"Page {i + 1}: {repeat} search needle benchmark scroll zoom memory."
        for i in range(page_count)
    ]
    path.write_bytes(make_sample.build())


with tempfile.TemporaryDirectory(prefix="fast-pdf-bench-") as directory:
    base = Path(directory)
    fixtures = {
        "p100": base / "p100.pdf",
        "p500": base / "p500.pdf",
        "p1200": base / "p1200.pdf",
        "small": ROOT / "samples" / "demo.pdf",
    }
    write_pdf(fixtures["p100"], 100, "needle")
    write_pdf(fixtures["p500"], 500, "needle")
    write_pdf(fixtures["p1200"], 1200, "needle")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserTestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    server = httpd
    payload = {
        "port": server.server_port,
        "fixtures": {k: str(v) for k, v in fixtures.items()},
    }
    print(json.dumps(payload), flush=True)
    try:
        threading.Event().wait()
    finally:
        server.shutdown()
