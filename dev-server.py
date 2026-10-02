#!/usr/bin/env python3
"""로컬 미리보기 서버: vercel.json 의 cleanUrls/rewrites 를 흉내낸다. `python3 dev-server.py` → http://localhost:8743"""
import http.server, os, re, socketserver

PORT = int(os.environ.get('PORT', 8743))
REWRITES = [(re.compile(r'^/biz/new/?$'), '/biz-new.html'), (re.compile(r'^/biz/verify/?$'), '/biz-verify.html'), (re.compile(r'^/biz/[^/]+/?$'), '/business.html'), (re.compile(r'^/product/[^/]+/?$'), '/product.html'), (re.compile(r'^/chat/[^/]+/?$'), '/chat.html'), (re.compile(r'^/profile/[^/]+/?$'), '/profile.html')]


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean, _, query = path.partition('?')
        for rx, dest in REWRITES:
            if rx.match(clean):
                clean = dest
                break
        else:
            if clean != '/' and '.' not in os.path.basename(clean) and os.path.exists('.' + clean + '.html'):
                clean += '.html'
        return super().translate_path(clean)


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print('판다산다 dev server → http://localhost:%d' % PORT)
    httpd.serve_forever()
