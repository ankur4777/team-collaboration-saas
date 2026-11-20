"""Deterministic CI translation fixture, never a production translation service."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
if os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.test_settings':
    raise RuntimeError('This fixture is only for config.test_settings')
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.end_headers();self.wfile.write(b'fixture-ready')
    def do_POST(self):
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<10000:self.send_error(400);return
        body=json.loads(self.rfile.read(size))
        if body.get('q')!='Caption test from owner' or body.get('source')!='en' or body.get('target')!='hi':
            self.send_error(400);return
        data=json.dumps({'translatedText':'मालिक की ओर से कैप्शन परीक्षण'}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
HTTPServer(('127.0.0.1',8899),Handler).serve_forever()
