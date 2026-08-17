#!/usr/bin/env node
/**
 * Бэктест теннисной модели по историческим матчам.
 *
 * ЧТО ЭТОТ БЭКТЕСТ ПРОВЕРЯЕТ, А ЧТО НЕТ.
 *
 * Проверяет калибровку: случаются ли заявленные 70% именно в 70% случаев, и
 * совпадает ли предсказанное распределение по счетам с наблюдаемым. Это и есть
 * условие, без которого на рынке с маржой 15-25% ловить нечего.
 *
 * НЕ проверяет прибыльность: исторических котировок на точный счёт в открытом
 * доступе нет. Модель, которая плохо откалибрована, проиграет гарантированно;
 * модель, которая откалибрована хорошо, — всего лишь может выиграть. Проверка
 * деньгами требует архива котировок, см. раздел в README.
 *
 * Прогон идёт строго по времени: матч прогнозируется по данным, известным до
 * него, и только потом попадает в статистику. Без этого метрики получаются
 * прекрасными и полностью фиктивными.
 *
 *   node scripts/backtest.js --tour atp --from 2021 --to 2025
 *   node scripts/backtest.js --tour wta --surface clay --half-life-days 200
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseCsv } from '../src/csv.js';
import { runBacktest } from '../src/backtest/engine.js';
import {
  brier, logLoss, multiclassLogLoss, skillScore,
  calibration, calibrationError, outcomeFrequencies,
} from '../src/backtest/metrics.js';
import {
  fitPlatt, fitTemperature, applyPlatt, applyTemperature,
} from '../src/calibration.js';

const SOURCES = {
  atp: 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_%YEAR%.csv',
  wta: 'https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_%YEAR%.csv',
};

const SURFACES = ['hard', 'clay', 'grass', 'carpet'];

function parseArgs(argv) {
  const args = {
    tour: 'atp',
    from: new Date().getFullYear() - 4,
    to: new Date().getFullYear(),
    surface: null,
    halfLifeDays: 365,
    minMatches: 5,
    prior: 20,
    warmup: 0.2,
    // Локальные CSV вместо загрузки: повторный прогон не должен снова
    // тянуть десятки мегабайт, а на сервере без доступа наружу это
    // единственный способ.
    file: null,
    // Доля выборки на обучение поправки. Остальное — честная проверка:
    // обучать и проверять на одних данных бессмысленно.
    calibrationSplit: 0.5,
    saveCalibration: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value == null) continue;
    if (key in args) args[key] = typeof args[key] === 'number' ? Number(value) : value;
  }
  return args;
}

const parseDate = (raw) => {
  const text = String(raw ?? '');
  if (!/^\d{8}$/.test(text)) return null;
  return new Date(Date.UTC(+text.slice(0, 4), +text.slice(4, 6) - 1, +text.slice(6, 8)));
};

function toMatches(rows, tour, label) {
  const matches = [];
  for (const row of rows) {
    const surface = String(row.surface ?? '').toLowerCase();
    const date = parseDate(row.tourney_date);
    if (!SURFACES.includes(surface) || !date) continue;

    const wSp = Number(row.w_svpt);
    const lSp = Number(row.l_svpt);
    const wWon = Number(row.w_1stWon) + Number(row.w_2ndWon);
    const lWon = Number(row.l_1stWon) + Number(row.l_2ndWon);
    if (![wSp, lSp, wWon, lWon].every(Number.isFinite)) continue;
    if (wSp <= 0 || lSp <= 0 || wWon > wSp || lWon > lSp) continue;
    if (!row.winner_name || !row.loser_name) continue;

    matches.push({
      date,
      tour,
      surface,
      bestOf: Number(row.best_of) === 5 ? 5 : 3,
      winner: row.winner_name,
      loser: row.loser_name,
      score: row.score,
      serve: {
        winner: { spWon: wWon, sp: wSp, rpWon: lSp - lWon, rp: lSp },
        loser: { spWon: lWon, sp: lSp, rpWon: wSp - wWon, rp: wSp },
      },
    });
  }

  console.log(`  ${label}: ${matches.length} матчей`);
  return matches;
}

async function loadYear(tour, year) {
  const url = SOURCES[tour].replace('%YEAR%', String(year));
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  ${tour} ${year}: пропущен (HTTP ${res.status})`);
    return [];
  }
  return toMatches(parseCsv(await res.text()), tour, `${tour} ${year}`);
}

async function loadFile(tour, path) {
  return toMatches(parseCsv(await readFile(path, 'utf8')), tour, path);
}

/**
 * Базовые уровни считаются по разогревочной части выборки, а не по всей:
 * иначе в прогноз просачивается знание о будущем.
 */
function computeBaselines(matches, warmupFraction) {
  const ordered = [...matches].sort((a, b) => a.date - b.date);
  const warmup = ordered.slice(0, Math.max(1, Math.floor(ordered.length * warmupFraction)));

  const totals = new Map();
  for (const match of warmup) {
    const key = `${match.tour}|${match.surface}`;
    if (!totals.has(key)) totals.set(key, { won: 0, points: 0 });
    const tally = totals.get(key);
    tally.won += match.serve.winner.spWon + match.serve.loser.spWon;
    tally.points += match.serve.winner.sp + match.serve.loser.sp;
  }

  const baselines = {};
  for (const [key, tally] of totals) {
    const [tour, surface] = key.split('|');
    baselines[tour] ??= {};
    baselines[tour][surface] = tally.won / tally.points;
  }
  return { baselines, warmupSize: warmup.length, cutoff: warmup.at(-1)?.date ?? null };
}

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value, digits = 4) => (value == null ? '—' : value.toFixed(digits));

/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2));
console.log(args.file
  ? `Тур ${args.tour}, файлы: ${args.file}`
  : `Тур ${args.tour}, годы ${args.from}-${args.to}`);

const all = [];
if (args.file) {
  for (const path of String(args.file).split(',')) {
    all.push(...(await loadFile(args.tour, path.trim())));
  }
} else {
  for (let year = args.from; year <= args.to; year++) {
    all.push(...(await loadYear(args.tour, year)));
  }
}

const matches = args.surface ? all.filter((m) => m.surface === args.surface) : all;

if (matches.length === 0) {
  console.error('\nНи одного матча не загружено. Проверь годы и доступ в сеть.');
  process.exit(1);
}

const { baselines, warmupSize, cutoff } = computeBaselines(matches, args.warmup);
console.log(`\nМатчей: ${matches.length}${args.surface ? ` (покрытие: ${args.surface})` : ''}`);
console.log(`Разогрев для базовых уровней: ${warmupSize} матчей до ${cutoff?.toISOString().slice(0, 10)}`);
console.log('Базовые уровни подачи:');
for (const [tour, bySurface] of Object.entries(baselines)) {
  for (const [surface, value] of Object.entries(bySurface)) {
    console.log(`  ${tour} ${surface}: ${pct(value)}`);
  }
}

const { predictions, counters } = runBacktest(matches, {
  halfLifeDays: args.halfLifeDays,
  prior: args.prior,
  minMatches: args.minMatches,
  baselines,
});

console.log(`\nСпрогнозировано: ${counters.predicted}`);
console.log(`  пропущено из-за счёта (снятия, неразобранное): ${counters.skippedScore}`);
console.log(`  пропущено из-за нехватки статистики: ${counters.skippedStats}`);

if (counters.predicted === 0) {
  console.error('\nНечего оценивать. Увеличь период или уменьши --min-matches.');
  process.exit(1);
}

console.log('\n' + '='.repeat(64));
console.log('ПОБЕДИТЕЛЬ МАТЧА');
console.log('='.repeat(64));
console.log(`  Брайер:            ${num(brier(predictions.matchWinner))}   (монетка: 0.2500)`);
console.log(`  Лог-потеря:        ${num(logLoss(predictions.matchWinner))}   (монетка: 0.6931)`);
console.log(`  Навык над базой:   ${pct(skillScore(predictions.matchWinner))}`);
console.log(`  Ошибка калибровки: ${pct(calibrationError(predictions.matchWinner))}`);

console.log('\n  Калибровка по корзинам:');
console.log('    прогноз      обещано   случилось   матчей   расхождение');
for (const row of calibration(predictions.matchWinner)) {
  const gap = row.observed - row.predicted;
  const gapText = `${gap >= 0 ? '+' : ''}${pct(gap)}`;
  // На корзине из полутора десятков матчей расхождение — это шум, а не
  // перекос. Помечаем только там, где выборка что-то значит.
  const flag = row.count >= 30 && Math.abs(gap) > 0.05 ? '  <-- перекос' : '';
  console.log(
    `    ${`${pct(row.from)}-${pct(row.to)}`.padEnd(14)}`
    + `${pct(row.predicted).padStart(8)}${pct(row.observed).padStart(12)}`
    + `${String(row.count).padStart(9)}${gapText.padStart(9)}${flag}`,
  );
}

console.log('\n' + '='.repeat(64));
console.log('ТОЧНЫЙ СЧЁТ МАТЧА');
console.log('='.repeat(64));
console.log(`  Лог-потеря: ${num(multiclassLogLoss(predictions.matchScore))}`);
console.log('\n    счёт    предсказано   наблюдалось   случаев');
for (const row of outcomeFrequencies(predictions.matchScore)) {
  console.log(
    `    ${row.label.padEnd(8)}${pct(row.predicted).padStart(10)}`
    + `${pct(row.observed).padStart(14)}${String(row.count).padStart(10)}`,
  );
}

console.log('\n' + '='.repeat(64));
console.log('ТОЧНЫЙ СЧЁТ ПЕРВОГО СЕТА');
console.log('='.repeat(64));
console.log(`  Лог-потеря: ${num(multiclassLogLoss(predictions.firstSetScore))}`);
console.log('\n    счёт    предсказано   наблюдалось   случаев');
for (const row of outcomeFrequencies(predictions.firstSetScore)) {
  console.log(
    `    ${row.label.padEnd(8)}${pct(row.predicted).padStart(10)}`
    + `${pct(row.observed).padStart(14)}${String(row.count).padStart(10)}`,
  );
}

/* ------------------------------------------------------------------ */
/* Поправка вероятностей                                               */
/* ------------------------------------------------------------------ */

const split = (rows) => {
  const cut = Math.floor(rows.length * args.calibrationSplit);
  return { train: rows.slice(0, cut), test: rows.slice(cut) };
};

const winner = split(predictions.matchWinner);
const matchScore = split(predictions.matchScore);
const firstSet = split(predictions.firstSetScore);

let helps = false;
const fitted = {
  winner: fitPlatt(winner.train),
  matchScore: fitTemperature(matchScore.train),
  firstSetScore: fitTemperature(firstSet.train),
};

console.log('\n' + '='.repeat(64));
console.log('ПОПРАВКА ВЕРОЯТНОСТЕЙ');
console.log('='.repeat(64));
console.log(`  Обучение: ${winner.train.length} матчей, проверка: ${winner.test.length}`);

if (!fitted.winner.fitted) {
  console.log('  Выборки не хватает — поправка не подбиралась.');
} else {
  const direction = fitted.winner.a > 1 ? 'недоуверенной' : 'переуверенной';
  console.log(`  Платт: a=${num(fitted.winner.a, 3)}, b=${num(fitted.winner.b, 3)}`);
  console.log(`    a ${fitted.winner.a > 1 ? '>' : '<'} 1 — модель была ${direction}.`);
  console.log(`  Температура счёта матча:  ${num(fitted.matchScore.temperature, 3)}`);
  console.log(`  Температура счёта сета:   ${num(fitted.firstSetScore.temperature, 3)}`);

  const before = winner.test;
  const after = before.map((row) => ({ ...row, p: applyPlatt(row.p, fitted.winner) }));

  const scoreBefore = matchScore.test;
  const scoreAfter = scoreBefore.map((row) => ({
    ...row,
    probs: applyTemperature(row.probs, fitted.matchScore.temperature),
  }));

  console.log('\n  На проверочной половине (её поправка не видела):');
  console.log('                          было      стало');
  console.log(`    Брайер:            ${num(brier(before))}    ${num(brier(after))}`);
  console.log(`    Лог-потеря:        ${num(logLoss(before))}    ${num(logLoss(after))}`);
  console.log(`    Ошибка калибровки: ${pct(calibrationError(before)).padStart(6)}    ${pct(calibrationError(after)).padStart(6)}`);
  console.log(`    Счёт, лог-потеря:  ${num(multiclassLogLoss(scoreBefore))}    ${num(multiclassLogLoss(scoreAfter))}`);

  // Решение принимается по лог-потере: это строгое правило оценки, его нельзя
  // улучшить, сместив прогнозы, — в отличие от одной лишь ошибки калибровки.
  const lossGain = logLoss(before) - logLoss(after);
  helps = lossGain > 1e-4;

  if (helps) {
    console.log(`\n  Поправка помогает: лог-потеря ниже на ${num(lossGain)},`);
    console.log(`  ошибка калибровки ${pct(calibrationError(before))} -> ${pct(calibrationError(after))}.`);
  } else if (lossGain < -1e-4) {
    console.log(`\n  ПОПРАВКА ВРЕДИТ: лог-потеря выросла на ${num(-lossGain)}.`);
    console.log('  Значит расхождение на обучающей половине было шумом, а не смещением,');
    console.log('  и поправка выучила именно шум. Сохранять её нельзя.');
  } else {
    console.log('\n  Поправка ничего не меняет — модель и так откалибрована.');
  }

  // Упор в границу поиска означает вырожденное распределение, а не находку.
  for (const [name, result] of [['счёта матча', fitted.matchScore], ['счёта сета', fitted.firstSetScore]]) {
    if (result.temperature < 0.32 || result.temperature > 2.9) {
      console.log(`  Внимание: температура ${name} упёрлась в границу (${num(result.temperature, 2)}).`);
      console.log('  Обычно это признак вырожденных данных, а не реального смещения.');
    }
  }
}

const force = process.argv.includes('--force-calibration');

if (args.saveCalibration && !helps && !force) {
  console.log('\n  Поправка НЕ сохранена: на проверке она не улучшила прогноз.');
  console.log('  Сохранить принудительно: --force-calibration');
} else if (args.saveCalibration) {
  const payload = {
    generatedAt: new Date().toISOString(),
    tour: args.tour,
    surface: args.surface,
    sample: { train: winner.train.length, test: winner.test.length },
    winner: { a: fitted.winner.a, b: fitted.winner.b },
    matchScore: { temperature: fitted.matchScore.temperature },
    firstSetScore: { temperature: fitted.firstSetScore.temperature },
  };
  await mkdir(dirname(args.saveCalibration), { recursive: true });
  await writeFile(args.saveCalibration, JSON.stringify(payload, null, 1));
  console.log(`\n  Записано: ${args.saveCalibration}`);
  console.log(`  Подключение: TENNIS_CALIBRATION_PATH=${args.saveCalibration}`);
}

console.log('\n' + '='.repeat(64));
console.log('Как читать результат:');
console.log('  - Брайер заметно ниже 0.25 и навык выше нуля — модель несёт информацию.');
console.log('  - Ошибка калибровки выше 3-4% — на точном счёте такую модель');
console.log('    съест маржа быстрее, чем она успеет что-то заработать.');
console.log('  - В таблицах счетов важно совпадение колонок «предсказано» и');
console.log('    «наблюдалось» по КАЖДОЙ строке, а не в сумме.');
console.log('  - Прибыльность это не измеряет: нужен архив котировок.');
console.log('  - Поправку стоит сохранять и подключать к боевому расчёту:');
console.log('      npm run backtest -- --save-calibration data/tennis-calibration.json');
