"""Generate a tiny multi-page PDF for local testing (no extra deps)."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "samples" / "demo.pdf"

PAGES = [
    "Fast PDF Viewer Demo Page 1. Search for translation and history.",
    "Page 2 mentions OpenRouter, zoom 150 percent, and back navigation.",
    "Page 3 repeats translation so search can show multiple hits.",
    "Page 4 is for scrolling smoothness at 150 percent zoom.",
    "Page 5 last page. Use Back to return after jumping here.",
]


def escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def page_stream(text: str) -> bytes:
    content = f"BT /F1 18 Tf 72 720 Td ({escape(text)}) Tj ET\n"
    return content.encode("latin-1")


def build() -> bytes:
    objs: list[bytes] = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + i} 0 R" for i in range(len(PAGES)))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(PAGES)} >>".encode())

    font_id = 3 + len(PAGES) * 2
    streams = [page_stream(text) for text in PAGES]
    for i, stream in enumerate(streams):
        page_id = 3 + i
        contents_id = 3 + len(PAGES) + i
        objs.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Contents {contents_id} 0 R /Resources << /Font << /F1 {font_id} 0 R >> >> >>"
            ).encode()
        )
    for stream in streams:
        objs.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"endstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out.extend(f"{index} 0 obj\n".encode())
        out.extend(obj)
        out.extend(b"\nendobj\n")
    xref = len(out)
    out.extend(f"xref\n0 {len(objs) + 1}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        out.extend(f"{offset:010d} 00000 n \n".encode())
    out.extend(
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(build())
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
