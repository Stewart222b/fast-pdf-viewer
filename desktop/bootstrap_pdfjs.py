"""Install a pinned, integrity-checked pdf.js distribution for offline use."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'web' / 'vendor' / 'pdfjs'
VERSION = '6.3.289'
TARBALL = f'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-{VERSION}.tgz'
INTEGRITY = 'ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw=='
FILES = {'build/pdf.mjs', 'build/pdf.worker.mjs', 'web/pdf_viewer.css', 'web/pdf_viewer.mjs'}
FOLDERS = ('cmaps/', 'standard_fonts/', 'wasm/', 'iccs/')


def installed_valid(directory: Path = VENDOR) -> bool:
    try:
        manifest = json.loads((directory / 'MANIFEST.json').read_text(encoding='utf-8'))
        if manifest['version'] != VERSION or not FILES.issubset(manifest['files']):
            return False
        if (directory / 'VERSION').read_text().strip() != VERSION:
            return False
        for folder in FOLDERS[:3]:
            if not any(name.startswith(folder) for name in manifest['files']):
                return False
        for name, digest in manifest['files'].items():
            if not safe_path(name) or hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def safe_path(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and '..' not in path.parts and '\\' not in name and ':' not in name


def install(payload: bytes, directory: Path = VENDOR) -> None:
    actual = base64.b64encode(hashlib.sha512(payload).digest()).decode('ascii')
    if actual != INTEGRITY:
        raise ValueError('pdf.js 下载校验失败，请重试。')
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pdfjs-install-', dir=directory.parent) as temp:
        staging = Path(temp) / 'new'
        staging.mkdir()
        hashes = {}
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            for member in archive:
                if not member.name.startswith('package/'):
                    continue
                name = member.name.removeprefix('package/')
                if not safe_path(name):
                    raise ValueError('pdf.js 压缩包包含不安全路径。')
                if not (name in FILES or name.startswith(FOLDERS)) or not member.isfile():
                    continue
                content = archive.extractfile(member).read()
                target = staging / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                hashes[name] = hashlib.sha256(content).hexdigest()
        (staging / 'VERSION').write_text(VERSION + '\n', encoding='utf-8')
        (staging / 'MANIFEST.json').write_text(json.dumps({'version': VERSION, 'files': hashes}), encoding='utf-8')
        if not installed_valid(staging):
            raise ValueError('pdf.js 资源不完整，未替换现有安装。')
        backup = Path(temp) / 'previous'
        if directory.exists():
            directory.rename(backup)
        try:
            staging.rename(directory)
        except OSError:
            if backup.exists():
                backup.rename(directory)
            raise


def main() -> None:
    if installed_valid():
        print(f'pdf.js {VERSION} already verified.')
        return
    print(f'Downloading pdf.js {VERSION}...')
    request = urllib.request.Request(TARBALL, headers={'User-Agent': 'fast-pdf-viewer'})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    install(payload)
    print(f'Installed and verified pdf.js {VERSION} -> {VENDOR}')


if __name__ == '__main__':
    main()
