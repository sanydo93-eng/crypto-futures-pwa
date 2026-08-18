#!/usr/bin/env node
/**
 * Статическая сборка приложения.
 *
 * Приложение — это Node-сервер, и на хостингах статики (GitHub Pages и
 * подобных) он не запустится. Но интерфейс полностью статический, а данные
 * можно посчитать заранее и вшить в страницу. Получается витрина, которая
 * открывается по HTTPS без сервера: смотреть с телефона, показывать кому-то,
 * ставить на домашний экран.
 *
 * Живые котировки в такой сборке не обновляются — для них нужен сервер.
 *
 *   node scripts/build-static.js              # каталог docs/ для GitHub Pages
 *   node scripts/build-static.js --single     # плюс один файл standalone.html
 */
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createTennisProvider, createFootballProvider } from '../src/providers/index.js';
import { evaluateAll } from '../src/tennis/signals.js';
import { evaluateAllFixtures } from '../src/football/signals.js';
import { buildStrengths } from '../src/football/strength.js';
import { demoHistory } from '../src/providers/football/mock.js';
import { PlayerStats } from '../src/tennis/stats.js';

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'docs';
const SINGLE = process.argv.includes('--single');
// Витрина для площадок, которые сами оборачивают страницу в документ:
// собственные <!doctype>, <html>, <head> и <body> там лишние.
const ARTIFACT = process.argv.includes('--artifact');

const config = loadConfig();

/* ---------- данные ---------- */

async function collect() {
  const tennisProvider = createTennisProvider(config);
  const footballProvider = createFootballProvider(config);

  const matches = await tennisProvider.fetchMatches();
  const fixtures = await footballProvider.fetchFixtures();
  const strengths = buildStrengths(demoHistory(), { competition: 'Демо-лига' });
  const playerStats = await PlayerStats.load(config.tennis.statsPath);

  const stamp = new Date().toISOString();

  const tennisRows = playerStats.size > 0
    ? playerStats.table({ limit: 200 })
    : matches
      .flatMap((m) => [m.players.a, m.players.b].map((p) => ({ ...p, tour: m.tour })))
      .map((p) => ({
        name: p.name, tour: p.tour, spw: p.spw, rpw: p.rpw,
        matches: p.matches ?? null, combined: p.spw + p.rpw,
      }))
      .sort((a, b) => b.combined - a.combined);

  return {
    generatedAt: stamp,
    signals: {
      tennis: {
        sport: 'tennis',
        provider: tennisProvider.name,
        generatedAt: stamp,
        settings: config.scoring,
        matches: evaluateAll(matches, config.scoring),
        signalCount: 0,
      },
      football: {
        sport: 'football',
        provider: footballProvider.name,
        generatedAt: stamp,
        settings: config.scoring,
        matches: evaluateAllFixtures(fixtures, config.scoring, strengths),
        signalCount: 0,
      },
    },
    stats: {
      tennis: {
        sport: 'tennis',
        source: playerStats.size > 0 ? 'archive' : 'fixtures',
        note: playerStats.size > 0 ? undefined
          : 'Архив игроков не собран — показаны участники матчей витрины.',
        rows: tennisRows,
      },
      football: {
        sport: 'football',
        source: 'synthetic',
        note: 'Демо-данные: синтетическая история.',
        competition: strengths.competition,
        league: strengths.league,
        rows: strengths.table(),
      },
    },
  };
}

/* ---------- сборка ---------- */

const data = await collect();
for (const sport of ['tennis', 'football']) {
  data.signals[sport].signalCount = data.signals[sport].matches
    .reduce((sum, m) => sum + m.signals.length, 0);
}

const [html, css, js, sw, manifest] = await Promise.all([
  readFile('public/index.html', 'utf8'),
  readFile('public/styles.css', 'utf8'),
  readFile('public/app.js', 'utf8'),
  readFile('public/sw.js', 'utf8'),
  readFile('public/manifest.webmanifest', 'utf8'),
]);

const embed = `<script>window.EMBEDDED_DATA=${JSON.stringify(data)};</script>`;

/* Каталог для хостинга статики. Пути делаем относительными: на GitHub Pages
   приложение живёт в подкаталоге, и любой абсолютный /styles.css бьёт мимо. */
await mkdir(OUT, { recursive: true });

const relative = (text) => text
  .replace(/(href|src)="\/([^"]*)"/g, '$1="./$2"')
  .replace(/'\/([a-z0-9.\-]+\.(?:js|css|png|webmanifest))'/gi, "'./$1'");

await writeFile(
  join(OUT, 'index.html'),
  relative(html).replace('<script src="./app.js"', `${embed}\n<script src="./app.js"`),
);
await writeFile(join(OUT, 'styles.css'), css);
await writeFile(join(OUT, 'app.js'), js);
await writeFile(join(OUT, 'sw.js'), relative(sw));
await writeFile(
  join(OUT, 'manifest.webmanifest'),
  manifest.replace(/"(start_url|scope)": "\/"/g, '"$1": "./"').replace(/"src": "\//g, '"src": "./'),
);

// Пустой файл отключает обработку Jekyll — иначе GitHub Pages прячет
// файлы и каталоги, начинающиеся с подчёркивания.
await writeFile(join(OUT, '.nojekyll'), '');

for (const file of await readdir('public')) {
  if (file.endsWith('.png')) await copyFile(join('public', file), join(OUT, file));
}

console.log(`Каталог для хостинга: ${OUT}/`);

/* Один файл: всё внутри, включая стили, скрипт и данные. */
if (SINGLE) {
  const inlineIcon = `data:image/png;base64,${(await readFile('public/favicon-32.png')).toString('base64')}`;
  const single = html
    .replace('<link rel="stylesheet" href="/styles.css">', `<style>\n${css}\n</style>`)
    .replace('<script src="/app.js" type="module"></script>', `${embed}\n<script type="module">\n${js}\n</script>`)
    .replace('<link rel="manifest" href="/manifest.webmanifest">', '')
    .replace(/<link rel="(icon|apple-touch-icon)"[^>]*>/g, `<link rel="icon" href="${inlineIcon}">`);

  await writeFile(join(OUT, 'standalone.html'), single);
  console.log(`Один файл: ${OUT}/standalone.html`);
}

if (ARTIFACT) {
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
    .replace('<script src="/app.js" type="module"></script>', '');
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? 'Сигналы';

  await writeFile(join(OUT, 'artifact.html'), [
    `<title>${title}</title>`,
    `<style>\n${css}\n</style>`,
    body.trim(),
    embed,
    `<script type="module">\n${js}\n</script>`,
  ].join('\n'));
  console.log(`Для артефакта: ${OUT}/artifact.html`);
}

console.log(`Матчей: теннис ${data.signals.tennis.matches.length}, футбол ${data.signals.football.matches.length}`);
console.log(`Сигналов: теннис ${data.signals.tennis.signalCount}, футбол ${data.signals.football.signalCount}`);
