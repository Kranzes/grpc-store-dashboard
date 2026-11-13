// A plain static file server for the built site under a sub-path, as a
// simple static host would serve it. /dash/ serves build/index.html,
// /dash/<dir>/ serves build/<dir>/index.html, and it rewrites nothing.
// Usage: node e2e/static-server.ts [port] [prefix]

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 4173);
const prefix = process.argv[3] ?? '/dash/';
const root = join(import.meta.dirname, '..', 'build');

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain',
	'.png': 'image/png',
	'.woff2': 'font/woff2'
};

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;
const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false;

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const path = decodeURIComponent(url.pathname);
	const notFound = () => {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
	};
	if (!path.startsWith(prefix)) return notFound();
	let file = join(root, normalize(path.slice(prefix.length)).replace(/^(\.\.(\/|$))+/, ''));
	if (await isDir(file)) {
		// Directories need their trailing slash, as on any static host.
		if (!path.endsWith('/')) {
			res.writeHead(301, { location: `${path}/${url.search}` });
			res.end();
			return;
		}
		file = join(file, 'index.html');
	}
	if (!(await isFile(file))) return notFound();
	res.writeHead(200, {
		'content-type': types[extname(file)] ?? 'application/octet-stream',
		'cache-control': 'no-store'
	});
	createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () =>
	console.log(`serving build/ at http://localhost:${port}${prefix}`)
);
