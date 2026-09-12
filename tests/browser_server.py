"""Local server and deterministic fixtures for browser-smoke.mjs."""
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


def build_multiline_pdf() -> bytes:
    def escape(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    # Each TOC field is a separate text item, with proportional Helvetica.
    parts = []
    for row in range(18):
        y = 720 - row * 28
        title = "Overview of SurfRDS" if row == 1 else f"Section {chr(65 + row)} details"
        for x, text in [(40, str(row + 1)), (72, title), (310, "." * 24), (480, str(row + 3))]:
            parts.append(f"BT /F1 16 Tf 1 0 0 1 {x} {y} Tm ({escape(text)}) Tj ET")
    parts.append("BT /F1 16 Tf 0 1 -1 0 550 400 Tm (Rotated SurfRDS) Tj ET")
    stream = "\n".join(parts).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 6 0 R 7 0 R] /Count 3 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    objs.extend([objs[2], objs[2]])
    out = b"%PDF-1.4\n"
    offsets = [0]
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


with tempfile.TemporaryDirectory(prefix="fast-pdf-browser-") as directory:
    long_file = Path(directory) / "long.pdf"
    multiline_file = Path(directory) / "multiline.pdf"
    make_sample.PAGES = [f"Page {i + 1}: search needle and history regression." for i in range(120)]
    long_file.write_bytes(make_sample.build())
    multiline_file.write_bytes(build_multiline_pdf())
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserTestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(
        json.dumps(
            {
                "port": httpd.server_port,
                "long": str(long_file),
                "small": str(ROOT / "samples/demo.pdf"),
                "multiline": str(multiline_file),
            }
        ),
        flush=True,
    )
    try:
        threading.Event().wait()
    finally:
        httpd.shutdown()
