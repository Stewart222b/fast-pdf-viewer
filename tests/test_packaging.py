"""Wheel must ship web/ and samples/ for non-editable installs."""
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class WheelPackagingTests(unittest.TestCase):
    def test_wheel_includes_web_and_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            wheel_dir = Path(tmp) / 'wheels'
            wheel_dir.mkdir()
            subprocess.run(
                [sys.executable, '-m', 'pip', 'wheel', str(ROOT), '-w', str(wheel_dir), '--no-deps'],
                check=True,
                capture_output=True,
                text=True,
            )
            wheels = list(wheel_dir.glob('*.whl'))
            self.assertEqual(len(wheels), 1)
            with zipfile.ZipFile(wheels[0]) as archive:
                names = archive.namelist()
            self.assertIn('desktop/web/index.html', names)
            self.assertIn('desktop/samples/demo.pdf', names)

    def test_installed_layout_resolves_web_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'site'
            target.mkdir()
            wheel_dir = Path(tmp) / 'wheels'
            wheel_dir.mkdir()
            subprocess.run(
                [sys.executable, '-m', 'pip', 'wheel', str(ROOT), '-w', str(wheel_dir), '--no-deps'],
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                [
                    sys.executable,
                    '-m',
                    'pip',
                    'install',
                    '--no-deps',
                    '-q',
                    str(next(wheel_dir.glob('*.whl'))),
                    '-t',
                    str(target),
                ],
                check=True,
            )
            spec = importlib.util.spec_from_file_location('app', target / 'desktop' / 'app.py')
            app = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(app)
            self.assertTrue(app.WEB.is_dir())
            self.assertTrue((app.WEB / 'index.html').is_file())
            self.assertEqual(app.WEB, target / 'desktop' / 'web')


if __name__ == '__main__':
    unittest.main()
