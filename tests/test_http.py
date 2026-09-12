"""Run: python3 -m unittest discover -s tests -p 'test_*.py'"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

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


class PdfRangeTests(unittest.TestCase):
    def test_ranges_head_and_document_identity(self):
        server = app.start_server(0)
        try:
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / 'range.pdf'
                data = b'%PDF-' + bytes(range(256)) * 4096
                file.write_bytes(data)
                app.set_opened(file)
                old_id = app.opened['id']
                for header, status, expected in [
                    ('bytes=0-4', 206, data[:5]), ('bytes=5-', 206, data[5:]),
                    ('bytes=-8', 206, data[-8:]), ('bytes=9999999-', 416, b''),
                    ('bytes=-0', 416, b''), ('bytes=8-2', 416, b''),
                    ('bytes=0-1,4-5', 200, data),
                ]:
                    with self.subTest(range=header):
                        c = HTTPConnection(*server.server_address, timeout=3)
                        c.request('GET', '/opened.pdf', headers={'Range': header})
                        r = c.getresponse()
                        self.assertEqual(r.status, status)
                        self.assertEqual(r.read(), expected)
                        if status == 206:
                            self.assertTrue(r.getheader('Content-Range').startswith('bytes '))
                        c.close()
                c = HTTPConnection(*server.server_address, timeout=3)
                c.request('HEAD', '/opened.pdf')
                r = c.getresponse()
                self.assertEqual(r.status, 200)
                self.assertEqual(int(r.getheader('Content-Length')), len(data))
                self.assertEqual(r.getheader('Accept-Ranges'), 'bytes')
                self.assertEqual(r.read(), b'')
                c.close()
                c = HTTPConnection(*server.server_address, timeout=3)
                c.request('GET', '/opened/' + old_id + '.pdf')
                r = c.getresponse()
                self.assertEqual(r.status, 200)
                self.assertEqual(r.read(), data)
                c.close()
                current = app.opened['id']
                c = HTTPConnection(*server.server_address, timeout=3)
                c.request('GET', '/opened.pdf?id=' + current)
                r = c.getresponse()
                self.assertEqual(r.status, 200)
                self.assertEqual(r.read(), data)
                c.close()
                app.set_opened(file)
                c = HTTPConnection(*server.server_address, timeout=3)
                c.request('GET', '/opened.pdf?id=' + old_id)
                self.assertEqual(c.getresponse().status, 409)
                c.close()
                c = HTTPConnection(*server.server_address, timeout=3)
                c.request('GET', '/opened/' + old_id + '.pdf')
                self.assertEqual(c.getresponse().status, 409)
                c.close()
        finally:
            server.shutdown()
            server.server_close()
            app.set_opened(None)


class OpenPathRemovedTests(unittest.TestCase):
    def test_open_path_endpoint_is_disabled(self):
        server = app.start_server(0, quiet=True)
        try:
            connection = HTTPConnection(*server.server_address, timeout=3)
            try:
                payload = b'{"path":"/etc/passwd"}'
                connection.request(
                    'POST',
                    '/api/open-path',
                    body=payload,
                    headers={'Content-Type': 'application/json', 'Content-Length': str(len(payload))},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 404)
                response.read()
            finally:
                connection.close()
        finally:
            server.shutdown()
            server.server_close()


class BrowserSetOpenedTests(unittest.TestCase):
    def test_set_opened_endpoint_accepts_fixture_path(self):
        root = Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(root / 'desktop'))
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from browser_handler import BrowserTestHandler

        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / 'bench.pdf'
            pdf.write_bytes(b'%PDF-1.4\n')
            server = ThreadingHTTPServer(('127.0.0.1', 0), BrowserTestHandler)
            try:
                connection = HTTPConnection(*server.server_address, timeout=3)
                payload = json.dumps({'path': str(pdf)}).encode()
                connection.request(
                    'POST',
                    '/api/browser/set-opened',
                    body=payload,
                    headers={'Content-Type': 'application/json', 'Content-Length': str(len(payload))},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                data = json.loads(response.read().decode())
                self.assertTrue(data['ok'])
                self.assertEqual(app.opened['path'], str(pdf))
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                app.set_opened(None)


class ServerBindTests(unittest.TestCase):
    def test_busy_port_falls_back_instead_of_sharing(self):
        first = app.start_server(0, quiet=True)
        try:
            port = first.server_address[1]
            second = app.start_server(port, quiet=True)
            try:
                self.assertNotEqual(second.server_address[1], port)
                self.assertFalse(first.allow_reuse_address)
                self.assertFalse(second.allow_reuse_address)
            finally:
                second.shutdown()
                second.server_close()
        finally:
            first.shutdown()
            first.server_close()
            app.set_opened(None)


if __name__ == '__main__':
    unittest.main()
