// Serves the sanitized category fixture over localhost for offline crawl tests.
// Usage: node scripts/serve-fixture.mjs [port]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = parseInt(process.argv[2] || '39393', 10);
const categoryHtml = readFileSync('fixtures/html/category-satilik-adana-seyhan.html', 'utf8');

const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/satilik')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(categoryHtml);
        return;
    }
    // homepage / anything else: trivial valid page (pre-warm equivalent)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>fixture server</h1></body></html>');
});

server.listen(port, '127.0.0.1', () => {
    console.log(`fixture server on http://127.0.0.1:${port}`);
});
