import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './src/config.js';
import { createProvider } from './src/providers/index.js';
import { evaluateAll } from './src/signals.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Service worker и манифест не кэшируем: иначе обновление приложения
// не доезжает до уже установленного телефона.
const NO_CACHE = new Set(['/sw.js', '/manifest.webmanifest']);

const config = loadConfig();
const provider = createProvider(config);

let cache = { at: 0, payload: null };

async function buildPayload() {
  const matches = await provider.fetchMatches();
  const evaluated = evaluateAll(matches, config.scoring);

  return {
    generatedAt: new Date().toISOString(),
    provider: provider.name,
    settings: config.scoring,
    matches: evaluated,
    signalCount: evaluated.reduce((sum, m) => sum + m.signals.length, 0),
  };
}

async function getPayload({ force = false } = {}) {
  const fresh = Date.now() - cache.at < config.cacheTtlMs;
  if (!force && fresh && cache.payload) return cache.payload;

  const payload = await buildPayload();
  cache = { at: Date.now(), payload };
  return payload;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? '/index.html' : urlPath;

  // Защита от выхода за пределы public/.
  const target = join(PUBLIC_DIR, normalize(relative));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': NO_CACHE.has(relative) ? 'no-store' : 'public, max-age=300',
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('Not found');
    else {
      console.error(err);
      res.writeHead(500).end('Internal error');
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, provider: provider.name });
      return;
    }

    if (url.pathname === '/api/signals') {
      const payload = await getPayload({ force: url.searchParams.get('refresh') === '1' });
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Неизвестный эндпоинт' });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Сигналы на http://${config.host}:${config.port}/  (провайдер: ${provider.name})`);
  if (config.provider === 'mock') {
    console.log('Работают демо-данные. Боевой фид: PROVIDER=api-tennis API_TENNIS_KEY=...');
  }
});
