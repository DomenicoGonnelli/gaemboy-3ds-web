#!/usr/bin/env python3
"""Static server for azahar-web/dist with the cross-origin isolation headers WASM threads need
(COOP/COEP -> SharedArrayBuffer). /homebrew/* is served from ../test-homebrew (free homebrew only).
usage: serve.py [port]   (default 8766)"""
import http.server
import os
import sys
from functools import partial

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.normpath(os.path.join(HERE, '..', 'dist'))
HOMEBREW = os.path.normpath(os.path.join(HERE, '..', '..', 'test-homebrew'))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript'}

    def translate_path(self, path):
        clean = path.split('?', 1)[0].split('#', 1)[0]
        if clean.startswith('/homebrew/'):
            return os.path.join(HOMEBREW, os.path.basename(clean))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    server = http.server.ThreadingHTTPServer(('0.0.0.0', port), partial(Handler, directory=DIST))
    print(f'serving {DIST} on http://localhost:{port}/ (homebrew from {HOMEBREW})', flush=True)
    server.serve_forever()
