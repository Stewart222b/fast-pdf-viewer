"""Download pdfjs-dist into web/vendor/pdfjs for offline viewing."""

from __future__ import annotations

import json
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "web" / "vendor" / "pdfjs"
REGISTRY = "https://registry.npmjs.org/pdfjs-dist/latest"
KEEP_PREFIXES = (
    "package/build/pdf.mjs",
    "package/build/pdf.min.mjs",
    "package/build/pdf.worker.mjs",
    "package/build/pdf.worker.min.mjs",
    "package/web/pdf_viewer.css",
    "package/cmaps/",
    "package/standard_fonts/",
    "package/wasm/",
)


def should_keep(name: str) -> bool:
    return any(name == p or name.startswith(p) for p in KEEP_PREFIXES)


def main() -> None:
    print("Fetching pdfjs-dist metadata...")
    with urllib.request.urlopen(REGISTRY, timeout=60) as resp:
        meta = json.load(resp)
    version = meta["version"]
    tarball = meta["dist"]["tarball"]
    print(f"Downloading pdfjs-dist@{version}")
    print(tarball)

    VENDOR.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(tarball, headers={"User-Agent": "fast-pdf-viewer"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = resp.read()
    with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
        tmp.write(payload)
        tmp_path = Path(tmp.name)
    try:
        with tarfile.open(tmp_path, mode="r:gz") as tar:
            for member in tar.getmembers():
                if not member.isfile() or not should_keep(member.name):
                    continue
                rel = member.name.removeprefix("package/")
                dest = VENDOR / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                extracted = tar.extractfile(member)
                if extracted is None:
                    continue
                dest.write_bytes(extracted.read())
                print(f"  {rel}")
    finally:
        tmp_path.unlink(missing_ok=True)

    marker = VENDOR / "VERSION"
    marker.write_text(version + "\n", encoding="utf-8")
    print(f"Installed pdfjs-dist {version} -> {VENDOR}")


if __name__ == "__main__":
    main()
