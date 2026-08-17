#!/usr/bin/env node
/**
 * Сборка рейтингов футбольных команд из открытого архива football-data.co.uk.
 *
 * Этот источник выбран потому, что в нём есть колонки HTHG/HTAG — голы к перерыву.
 * Без них первый тайм пришлось бы оценивать долей от матча, а это заметное
 * смещение: во втором тайме забивают ощутимо чаще, чем в первом.
 *
 * Запуск:
 *   node scripts/build-football-stats.js --league E0 --seasons 2324,2425
 *   node scripts/build-football-stats.js --league SP1 --seasons 2425 --out data/laliga.json
 *
 * Коды лиг: E0 АПЛ, E1 Чемпионшип, SP1 Ла Лига, I1 Серия A,
 *           D1 Бундеслига, F1 Лига 1, N1 Эредивизи, P1 Португалия.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseCsv } from '../src/csv.js';
import { buildStrengths } from '../src/football/strength.js';

const URL_TEMPLATE = 'https://www.football-data.co.uk/mmz4281/%SEASON%/%LEAGUE%.csv';

function parseArgs(argv) {
  const args = { league: 'E0', seasons: null, out: null, prior: 6 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'seasons') args.seasons = value.split(',').map((s) => s.trim());
    else if (key === 'prior') args.prior = Number(value);
    else if (key in args) args[key] = value;
  }

  // По умолчанию — текущий и предыдущий сезоны в формате football-data (2425).
  if (!args.seasons) {
    const now = new Date();
    const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    const code = (y) => `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`;
    args.seasons = [code(startYear - 1), code(startYear)];
  }
  args.out ??= `data/football-${args.league}.json`;
  return args;
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

async function fetchSeason(league, season) {
  const url = URL_TEMPLATE.replace('%SEASON%', season).replace('%LEAGUE%', league);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  ${league} ${season}: пропущен (HTTP ${res.status})`);
    return [];
  }

  const rows = parseCsv(await res.text());
  const matches = rows
    .filter((r) => r.HomeTeam && r.AwayTeam)
    .map((r) => ({
      home: r.HomeTeam.trim(),
      away: r.AwayTeam.trim(),
      hg: number(r.FTHG),
      ag: number(r.FTAG),
      hthg: number(r.HTHG),
      htag: number(r.HTAG),
    }))
    .filter((m) => [m.hg, m.ag, m.hthg, m.htag].every(Number.isFinite));

  console.log(`  ${league} ${season}: ${matches.length} матчей`);
  return matches;
}

const args = parseArgs(process.argv.slice(2));
console.log(`Лига ${args.league}, сезоны: ${args.seasons.join(', ')}`);

const matches = [];
for (const season of args.seasons) {
  matches.push(...(await fetchSeason(args.league, season)));
}

if (matches.length === 0) {
  console.error('\nНи одного матча не загружено. Проверь код лиги и сезона:');
  console.error(URL_TEMPLATE.replace('%SEASON%', args.seasons[0]).replace('%LEAGUE%', args.league));
  process.exit(1);
}

const strengths = buildStrengths(matches, { prior: args.prior, competition: args.league });

await mkdir(dirname(args.out), { recursive: true });
await writeFile(args.out, JSON.stringify(strengths, null, 1));

const { league } = strengths;
const withGoal = matches.filter((m) => m.hthg + m.htag > 0).length;

console.log(`\nКоманд: ${strengths.size}, матчей: ${matches.length}`);
console.log(`Голы за матч:      хозяева ${league.full.home.toFixed(2)}, гости ${league.full.away.toFixed(2)}`);
console.log(`Голы в 1-м тайме:  хозяева ${league.firstHalf.home.toFixed(2)}, гости ${league.firstHalf.away.toFixed(2)}`);

const share1H = (league.firstHalf.home + league.firstHalf.away) / (league.full.home + league.full.away);
console.log(`Доля голов в 1-м тайме: ${(share1H * 100).toFixed(1)}%`);
console.log(`Матчей с голом в 1-м тайме: ${((withGoal / matches.length) * 100).toFixed(1)}% (факт)`);
console.log(`\nЗаписано: ${args.out}`);
console.log(`Подключение: FOOTBALL_STATS_PATH=${args.out}`);
