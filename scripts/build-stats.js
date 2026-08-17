#!/usr/bin/env node
/**
 * Сборка справочника статистики игроков из исторических матчей.
 *
 * Источник — открытые данные Джеффа Сакманна (github.com/JeffSackmann), лучший
 * бесплатный архив по ATP/WTA. Скрипт качает CSV по годам, считает для каждого
 * игрока долю выигранных очков на подаче и на приёме по покрытиям и заодно
 * пересчитывает базовые уровни тура.
 *
 * Запуск:
 *   node scripts/build-stats.js --from 2021 --to 2025
 *   node scripts/build-stats.js --tour wta --from 2023 --to 2025 --out data/wta.json
 *
 * Нужен доступ в интернет к raw.githubusercontent.com.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseCsv } from '../src/csv.js';

const SOURCES = {
  atp: 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_%YEAR%.csv',
  wta: 'https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_%YEAR%.csv',
};

const SURFACES = ['hard', 'clay', 'grass', 'carpet'];

function parseArgs(argv) {
  const args = {
    tour: ['atp', 'wta'],
    from: new Date().getFullYear() - 4,
    to: new Date().getFullYear(),
    out: 'data/player-stats.json',
    minMatches: 3,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'tour') args.tour = [value];
    else if (key === 'from' || key === 'to' || key === 'minMatches') args[key] = Number(value);
    else if (key === 'out') args.out = value;
  }
  return args;
}

function emptyTally() {
  return { servePointsWon: 0, servePoints: 0, returnPointsWon: 0, returnPoints: 0, matches: 0 };
}

function addTally(target, { spWon, sp, rpWon, rp }) {
  target.servePointsWon += spWon;
  target.servePoints += sp;
  target.returnPointsWon += rpWon;
  target.returnPoints += rp;
  target.matches += 1;
}

function finalize(tally) {
  if (!tally || tally.servePoints === 0 || tally.returnPoints === 0) return null;
  return {
    spw: tally.servePointsWon / tally.servePoints,
    rpw: tally.returnPointsWon / tally.returnPoints,
    matches: tally.matches,
  };
}

async function fetchYear(tour, year) {
  const url = SOURCES[tour].replace('%YEAR%', String(year));
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  ${tour} ${year}: пропущен (HTTP ${res.status})`);
    return [];
  }
  return parseCsv(await res.text());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const players = new Map();
  const tourTotals = new Map();

  for (const tour of args.tour) {
    for (let year = args.from; year <= args.to; year++) {
      const rows = await fetchYear(tour, year);
      let used = 0;

      for (const row of rows) {
        const surface = String(row.surface ?? '').toLowerCase();
        if (!SURFACES.includes(surface)) continue;

        // Очки на подаче: первая подача + вторая. Без этих полей матч бесполезен.
        const wSp = Number(row.w_svpt);
        const lSp = Number(row.l_svpt);
        const wWon = Number(row.w_1stWon) + Number(row.w_2ndWon);
        const lWon = Number(row.l_1stWon) + Number(row.l_2ndWon);
        if (![wSp, lSp, wWon, lWon].every(Number.isFinite) || wSp <= 0 || lSp <= 0) continue;

        // Отсев мусора: снятия и явные ошибки ввода.
        if (wWon > wSp || lWon > lSp) continue;
        if (/RET|W\/O|DEF/i.test(row.score ?? '')) continue;

        for (const [name, own, opp] of [
          [row.winner_name, { sp: wSp, won: wWon }, { sp: lSp, won: lWon }],
          [row.loser_name, { sp: lSp, won: lWon }, { sp: wSp, won: wWon }],
        ]) {
          if (!name) continue;
          const key = `${tour}|${name}`;
          if (!players.has(key)) {
            players.set(key, { tour, name, overall: emptyTally(), surfaces: {} });
          }
          const record = players.get(key);
          record.surfaces[surface] ??= emptyTally();

          const sample = {
            spWon: own.won,
            sp: own.sp,
            rpWon: opp.sp - opp.won,
            rp: opp.sp,
          };
          addTally(record.overall, sample);
          addTally(record.surfaces[surface], sample);
        }

        const totalKey = `${tour}|${surface}`;
        tourTotals.set(totalKey, tourTotals.get(totalKey) ?? emptyTally());
        addTally(tourTotals.get(totalKey), {
          spWon: wWon + lWon,
          sp: wSp + lSp,
          rpWon: 0,
          rp: 1,
        });
        used += 1;
      }
      console.log(`  ${tour} ${year}: ${used} матчей учтено`);
    }
  }

  const baselines = {};
  for (const [key, tally] of tourTotals) {
    const [tour, surface] = key.split('|');
    baselines[tour] ??= {};
    baselines[tour][surface] = tally.servePointsWon / tally.servePoints;
  }

  const output = { players: {} };
  for (const record of players.values()) {
    const overall = finalize(record.overall);
    if (!overall || overall.matches < args.minMatches) continue;

    const surfaces = {};
    for (const [surface, tally] of Object.entries(record.surfaces)) {
      const stats = finalize(tally);
      if (stats) surfaces[surface] = stats;
    }
    output.players[record.name] = { tour: record.tour, overall, surfaces };
  }

  // Пустой справочник хуже отсутствующего: он выглядит собранным, молча
  // делает всех игроков средними и никогда не пересобирается.
  const collected = Object.keys(output.players).length;
  if (collected === 0) {
    console.error('\nНи одного игрока не собрано — файл НЕ записан.');
    console.error('Обычные причины:');
    console.error('  - нет доступа к raw.githubusercontent.com;');
    console.error('  - указанные годы ещё не опубликованы в архиве.');
    console.error('Проверь: curl -sSI https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_2023.csv');
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'JeffSackmann/tennis_atp + tennis_wta',
    years: { from: args.from, to: args.to },
    baselines,
    players: output.players,
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(payload, null, 1));

  console.log(`\nИгроков: ${Object.keys(output.players).length}`);
  console.log('Базовые уровни подачи (перенеси их в src/tennis/serve.js):');
  console.dir(baselines, { depth: null });
  console.log(`Записано: ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
