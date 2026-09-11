"""Local server and deterministic fixtures for browser-smoke.mjs."""
import json
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop'))
import app
import make_sample

with tempfile.TemporaryDirectory(prefix='fast-pdf-browser-') as directory:
    long_file = Path(directory) / 'long.pdf'
    make_sample.PAGES = [f'Page {i + 1}: search needle and history regression.' for i in range(120)]
    long_file.write_bytes(make_sample.build())
    server = app.start_server(0)
    print(json.dumps({'port': server.server_port, 'long': str(long_file), 'small': str(ROOT / 'samples/demo.pdf')}), flush=True)
    try:
        threading.Event().wait()
    finally:
        server.shutdown()
