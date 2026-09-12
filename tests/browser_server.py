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


def build_multiline_pdf() -> bytes:
    def escape(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    lines = [
        "Row A: alpha beta gamma",
        "Row B: delta epsilon zeta",
        "Row C: eta theta iota",
    ]
    parts = ["BT /F1 16 Tf", "72 720 Td", f"({escape(lines[0])}) Tj"]
    for line in lines[1:]:
        parts.append("0 -28 Td")
        parts.append(f"({escape(line)}) Tj")
    parts.append("ET")
    stream = "\n".join(parts).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
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


with tempfile.TemporaryDirectory(prefix='fast-pdf-browser-') as directory:
    long_file = Path(directory) / 'long.pdf'
    multiline_file = Path(directory) / 'multiline.pdf'
    make_sample.PAGES = [f'Page {i + 1}: search needle and history regression.' for i in range(120)]
    long_file.write_bytes(make_sample.build())
    multiline_file.write_bytes(build_multiline_pdf())
    server = app.start_server(0)
    print(json.dumps({
        'port': server.server_port,
        'long': str(long_file),
        'small': str(ROOT / 'samples/demo.pdf'),
        'multiline': str(multiline_file),
    }), flush=True)
    try:
        threading.Event().wait()
    finally:
        server.shutdown()
