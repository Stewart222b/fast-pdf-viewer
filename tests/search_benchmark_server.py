"""Serve viewer and a 720-page PDF with 445 'surf' hits for search-benchmark.mjs."""
import json
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))
import app
import make_sample

PAGE_COUNT = 720
SURF_FIRST = 1
SURF_NEXT = 80
SURF_HITS = 445


def write_surf_pdf(path: Path) -> None:
    pages = []
    remaining = SURF_HITS - 1
    for i in range(PAGE_COUNT):
        page = i + 1
        if page == SURF_FIRST:
            pages.append(f"Page {page}: surf first hit in the user manual.")
        elif page >= SURF_NEXT and remaining > 0:
            pages.append(f"Page {page}: surf module documentation.")
            remaining -= 1
        else:
            pages.append(f"Page {page}: other chapter without the keyword.")
    make_sample.PAGES = pages
    path.write_bytes(make_sample.build())


with tempfile.TemporaryDirectory(prefix="fast-pdf-search-bench-") as directory:
    surf = Path(directory) / "surf-720.pdf"
    write_surf_pdf(surf)
    server = app.start_server(0)
    payload = {
        "port": server.server_port,
        "fixtures": {"surf720": str(surf)},
        "expected": {
            "pageCount": PAGE_COUNT,
            "surfHits": SURF_HITS,
            "firstHitPage": SURF_FIRST,
            "secondHitPage": SURF_NEXT,
        },
    }
    print(json.dumps(payload), flush=True)
    try:
        threading.Event().wait()
    finally:
        server.shutdown()
