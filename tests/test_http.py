"""Run: python3 -m unittest discover -s tests -p 'test_*.py'"""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from http.client import HTTPConnection

SPEC = importlib.util.spec_from_file_location('app', Path(__file__).parents[1] / 'desktop/app.py')
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)


class PdfResponseTests(unittest.TestCase):
    def test_unicode_and_special_filenames(self):
        server = app.start_server(0)
        try:
            with tempfile.TemporaryDirectory() as directory:
                for name in ['中文手册.pdf', 'manual.pdf', 'a b.pdf', "a'b;百分%#.pdf"]:
                    with self.subTest(name=name):
                        path = Path(directory) / name
                        payload = b'%PDF-1.4\nfilename regression\n'
                        path.write_bytes(payload)
                        app.set_opened(path)
                        connection = HTTPConnection(*server.server_address, timeout=3)
                        try:
                            connection.request('GET', '/opened.pdf')
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            self.assertEqual(response.read(), payload)
                            self.assertEqual(response.getheader('Content-Disposition'),
                                             'inline; filename="document.pdf"; filename*=UTF-8\'\'' + quote(name, safe=''))
                        finally:
                            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            app.set_opened(None)


if __name__ == '__main__':
    unittest.main()
