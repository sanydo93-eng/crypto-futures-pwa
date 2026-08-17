import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './src/config.js';
import { createTennisProvider, createFootballProvider } from './src/providers/index.js';
import { evaluateAll } from './src/tennis/signals.js';
import { evaluateAllFixtures } from './src/football/signals.js';
import { PlayerStats } from './src/tennis/stats.js';
import { TeamStrengths, buildStrengths } from './src/football/strength.js';
import { demoHistory } from './src/providers/football/mock.js';

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
const tennisProvider = createTennisProvider(config);
const footballProvider = createFootballProvider(config);

/* ------------------------------------------------------------------ */
/* Справочники статистики                                              */
/* ------------------------------------------------------------------ */

let tennisStatsPromise;
let tennisCalibrationPromise;
let footballStrengthsPromise;

const getTennisStats = () => (tennisStatsPromise ??= PlayerStats.load(config.tennis.statsPath));

/**
 * Поправка вероятностей. Её отсутствие — нормальный режим: пока бэктест не
 * доказал, что поправка помогает на отложенной выборке, модель работает как есть.
 */
const getTennisCalibration = () => (tennisCalibrationPromise ??= readFile(
  config.tennis.calibrationPath, 'utf8',
).then(JSON.parse).catch((err) => {
  if (err.code !== 'ENOENT') console.warn('Поправка не прочитана:', err.message);
  return null;
}));

/**
 * Рейтинги команд. Если справочник ещё не собран, демо-режим строит его из
 * синтетической истории — раздел статистики должен быть наполнен сразу,
 * а не пустовать до первого запуска скрипта сборки.
 */
const getFootballStrengths = () =>
  (footballStrengthsPromise ??= TeamStrengths.load(config.football.statsPath).then((loaded) => {
    if (loaded) return { strengths: loaded, synthetic: false };
    if (config.football.provider !== 'mock') return { strengths: null, synthetic: false };
    return {
      strengths: buildStrengths(demoHistory(), { competition: 'Демо-лига' }),
      synthetic: true,
    };
  }));

/* ------------------------------------------------------------------ */
/* Сигналы                                                             */
/* ------------------------------------------------------------------ */

const cache = new Map();

async function buildTennis() {
  const [matches, calibration] = await Promise.all([
    tennisProvider.fetchMatches(),
    getTennisCalibration(),
  ]);

  const evaluated = evaluateAll(matches, { ...config.scoring, calibration });
  return {
    sport: 'tennis',
    provider: tennisProvider.name,
    matches: evaluated,
    calibrated: Boolean(calibration),
  };
}

async function buildFootball() {
  const [fixtures, { strengths }] = await Promise.all([
    footballProvider.fetchFixtures(),
    getFootballStrengths(),
  ]);

  // Матч считается либо по заданным ожидаемым голам, либо по справочнику команд.
  // Без того и другого модель считать нечем — но это не повод ронять эндпоинт.
  const usable = fixtures.filter(
    (fixture) => Number.isFinite(fixture.lambdaHome) || Boolean(strengths),
  );

  const note = usable.length < fixtures.length
    ? `Пропущено матчей: ${fixtures.length - usable.length}. Справочник команд не собран — `
      + 'запусти node scripts/build-football-stats.js --league E0'
    : undefined;

  return {
    sport: 'football',
    provider: footballProvider.name,
    matches: evaluateAllFixtures(usable, config.scoring, strengths),
    note,
  };
}

const BUILDERS = { tennis: buildTennis, football: buildFootball };

async function getSignals(sport, { force = false } = {}) {
  const entry = cache.get(sport);
  if (!force && entry && Date.now() - entry.at < config.cacheTtlMs) return entry.payload;

  const built = await BUILDERS[sport]();
  const payload = {
    ...built,
    generatedAt: new Date().toISOString(),
    settings: config.scoring,
    signalCount: built.matches.reduce((sum, m) => sum + m.signals.length, 0),
  };

  cache.set(sport, { at: Date.now(), payload });
  return payload;
}

/* ------------------------------------------------------------------ */
/* Статистика                                                          */
/* ------------------------------------------------------------------ */

/**
 * Пока архив по игрокам не собран, показываем статистику участников
 * сегодняшних матчей — она приходит вместе с котировками.
 */
async function tennisStatsFallback(query) {
  const matches = await tennisProvider.fetchMatches();
  const needle = query.toLowerCase();

  return matches
    .flatMap((match) => [match.players.a, match.players.b].map((p) => ({ ...p, tour: match.tour })))
    .filter((p) => !needle || p.name.toLowerCase().includes(needle))
    .map((p) => ({
      name: p.name,
      tour: p.tour,
      spw: p.spw,
      rpw: p.rpw,
      matches: p.matches ?? null,
      combined: p.spw + p.rpw,
    }))
    .sort((a, b) => b.combined - a.combined);
}

async function getStats(sport, query) {
  if (sport === 'tennis') {
    const stats = await getTennisStats();
    if (stats.size > 0) {
      return {
        sport,
        source: 'archive',
        total: stats.size,
        rows: stats.table({ query, limit: 200 }),
      };
    }
    return {
      sport,
      source: 'fixtures',
      note: 'Архив по игрокам не собран — показаны участники ближайших матчей. '
        + 'Собрать: node scripts/build-stats.js --from 2021 --to 2025',
      rows: await tennisStatsFallback(query),
    };
  }

  const { strengths, synthetic } = await getFootballStrengths();
  if (!strengths) {
    return {
      sport,
      source: 'none',
      note: 'Справочник команд не собран. Собрать: node scripts/build-football-stats.js --league E0',
      rows: [],
    };
  }

  const needle = query.toLowerCase();
  return {
    sport,
    source: synthetic ? 'synthetic' : 'archive',
    note: synthetic
      ? 'Демо-данные: синтетическая история. Реальные: node scripts/build-football-stats.js --league E0'
      : undefined,
    competition: strengths.competition,
    league: strengths.league,
    total: strengths.size,
    rows: strengths.table().filter((row) => !needle || row.name.toLowerCase().includes(needle)),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

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

const sportOf = (url) => {
  const sport = url.searchParams.get('sport') ?? 'tennis';
  return sport === 'football' ? 'football' : 'tennis';
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        providers: { tennis: tennisProvider.name, football: footballProvider.name },
      });
      return;
    }

    if (url.pathname === '/api/signals') {
      sendJson(res, 200, await getSignals(sportOf(url), {
        force: url.searchParams.get('refresh') === '1',
      }));
      return;
    }

    if (url.pathname === '/api/stats') {
      sendJson(res, 200, await getStats(sportOf(url), url.searchParams.get('q') ?? ''));
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
  console.log(`Сигналы на http://${config.host}:${config.port}/`);
  console.log(`  теннис:  ${tennisProvider.name}`);
  console.log(`  футбол:  ${footballProvider.name}`);
  if (config.tennis.provider === 'mock') {
    console.log('Демо-данные. Боевой фид: PROVIDER=api-tennis API_TENNIS_KEY=...');
  }
});
