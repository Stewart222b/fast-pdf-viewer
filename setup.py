from __future__ import annotations

import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py as _build_py

ROOT = Path(__file__).resolve().parent


class build_py(_build_py):
    def run(self) -> None:
        super().run()
        build_lib = Path(self.build_lib)
        pkg = build_lib / "desktop"
        for name in ("web", "samples"):
            src = ROOT / name
            dst = pkg / name
            if not src.is_dir():
                continue
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)


setup(cmdclass={"build_py": build_py})
