import test from 'node:test';
import assert from 'node:assert/strict';

import { parseScore, fromPerspectiveOfA, isPlausible } from '../src/backtest/score.js';
import {
  brier, logLoss, multiclassLogLoss, skillScore,
  calibration, calibrationError, outcomeFrequencies,
} from '../src/backtest/metrics.js';
import { RollingStats, predictMatch, runBacktest } from '../src/backtest/engine.js';
import { matchDistribution } from '../src/tennis/match.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `ожидалось ${expected}, получено ${actual}`);

/* ---------- разбор счёта ---------- */

test('счёт: обычные записи разбираются', () => {
  assert.deepEqual(parseScore('6-4 6-3'), [[6, 4], [6, 3]]);
  assert.deepEqual(parseScore('7-6(3) 6-4'), [[7, 6], [6, 4]]);
  assert.deepEqual(parseScore('4-6 6-3 7-6(8)'), [[4, 6], [6, 3], [7, 6]]);
  assert.deepEqual(parseScore('6-0 6-0'), [[6, 0], [6, 0]]);
});

test('счёт: недоигранные матчи отбрасываются', () => {
  for (const bad of ['6-3 RET', 'W/O', '4-6 6-3 2-1 RET', 'DEF', '', null, undefined]) {
    assert.equal(parseScore(bad), null, `не отброшено: ${JSON.stringify(bad)}`);
  }
});

test('счёт: нестандартная запись не угадывается', () => {
  // Лучше пропустить матч, чем подставить выдуманный счёт.
  assert.equal(parseScore('6-4 [10-8]'), null);
  assert.equal(parseScore('шесть-четыре'), null);
});

test('счёт: приводится к стороне игрока A', () => {
  const sets = [[6, 4], [3, 6], [7, 5]];

  const asWinner = fromPerspectiveOfA(sets, true);
  assert.equal(asWinner.label, '2-1');
  assert.equal(asWinner.firstSet, '6-4');
  assert.equal(asWinner.aWon, true);

  const asLoser = fromPerspectiveOfA(sets, false);
  assert.equal(asLoser.label, '1-2');
  assert.equal(asLoser.firstSet, '4-6');
  assert.equal(asLoser.aWon, false);
});

test('счёт: проверка на соответствие формату матча', () => {
  assert.ok(isPlausible([[6, 4], [6, 3]], 3));
  assert.ok(isPlausible([[6, 4], [3, 6], [6, 2]], 3));
  assert.ok(isPlausible([[6, 4], [6, 3], [6, 2]], 5));

  // Один сет для трёх партий — недоигранный матч.
  assert.equal(isPlausible([[6, 4]], 3), false);
  // Четыре сета в матче из трёх невозможны.
  assert.equal(isPlausible([[6, 4], [3, 6], [6, 2], [6, 1]], 3), false);
});

/* ---------- метрики ---------- */

test('метрики: постоянный прогноз 50% даёт эталонные значения', () => {
  const coin = Array.from({ length: 100 }, (_, i) => ({ p: 0.5, outcome: i % 2 }));
  close(brier(coin), 0.25);
  close(logLoss(coin), Math.log(2), 1e-12);
});

test('метрики: идеальный прогноз даёт ноль', () => {
  const perfect = [{ p: 1, outcome: 1 }, { p: 0, outcome: 0 }];
  close(brier(perfect), 0);
  assert.ok(logLoss(perfect) < 1e-9);
});

test('метрики: уверенная ошибка наказывается сильно', () => {
  const wrong = [{ p: 0.999, outcome: 0 }];
  assert.ok(logLoss(wrong) > 6, 'лог-потеря должна взлететь');
  // Брайер ограничен единицей и такую ошибку недооценивает — потому обе метрики.
  close(brier(wrong), 0.998001, 1e-9);
});

test('метрики: навык над базовой частотой', () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ outcome: i < 70 ? 1 : 0 }));
  // Прогноз, равный базовой частоте, навыка не несёт.
  const flat = events.map((e) => ({ p: 0.7, outcome: e.outcome }));
  close(skillScore(flat), 0, 1e-12);

  const perfect = events.map((e) => ({ p: e.outcome, outcome: e.outcome }));
  close(skillScore(perfect), 1, 1e-12);
});

test('метрики: калибровка ловит систематический перекос', () => {
  // Модель обещает 80%, случается 50% — это ровно тот перекос, который убивает.
  const overconfident = Array.from({ length: 100 }, (_, i) => ({ p: 0.8, outcome: i % 2 }));
  const table = calibration(overconfident);

  assert.equal(table.length, 1);
  close(table[0].predicted, 0.8, 1e-12);
  close(table[0].observed, 0.5, 1e-12);
  close(calibrationError(overconfident), 0.3, 1e-12);
});

test('метрики: идеально откалиброванный прогноз даёт почти нулевую ошибку', () => {
  const predictions = [];
  for (let bucket = 0; bucket < 10; bucket++) {
    const p = bucket / 10 + 0.05;
    const ones = Math.round(p * 100);
    for (let i = 0; i < 100; i++) predictions.push({ p, outcome: i < ones ? 1 : 0 });
  }
  assert.ok(calibrationError(predictions) < 0.01, 'обещанное должно совпасть со случившимся');
});

test('метрики: многоклассовая потеря и частоты исходов', () => {
  const predictions = [
    { probs: { '2-0': 0.5, '2-1': 0.5 }, actual: '2-0' },
    { probs: { '2-0': 0.5, '2-1': 0.5 }, actual: '2-1' },
  ];
  close(multiclassLogLoss(predictions), Math.log(2), 1e-12);

  const rows = outcomeFrequencies(predictions);
  for (const row of rows) {
    close(row.predicted, 0.5, 1e-12);
    close(row.observed, 0.5, 1e-12);
  }
});

test('метрики: пустой вход не роняет расчёт', () => {
  assert.equal(brier([]), null);
  assert.equal(logLoss([]), null);
  assert.equal(calibrationError([]), null);
  assert.deepEqual(calibration([]), []);
});

/* ---------- накопление статистики ---------- */

const DAY = 86_400_000;
const at = (days) => new Date(Date.UTC(2024, 0, 1) + days * DAY);

const sample = (spw, rpw, points = 60) => ({
  spWon: spw * points,
  sp: points,
  rpWon: rpw * points,
  rp: points,
});

test('статистика: до минимума наблюдений оценка не выдаётся', () => {
  const stats = new RollingStats();
  stats.observe('A', 'hard', at(0), sample(0.7, 0.4));
  assert.equal(stats.estimate('A', 'hard', at(1), { baseline: 0.64, minMatches: 5 }), null);
});

test('статистика: оценка стягивается к базовому уровню', () => {
  const stats = new RollingStats({ prior: 20 });
  for (let i = 0; i < 5; i++) stats.observe('A', 'hard', at(i), sample(0.8, 0.4));

  const estimate = stats.estimate('A', 'hard', at(10), { baseline: 0.64, minMatches: 5 });
  // Наблюдалось 80%, но пяти матчей мало — оценка обязана быть заметно ниже.
  assert.ok(estimate.spw < 0.72, `слишком доверчиво: ${estimate.spw}`);
  assert.ok(estimate.spw > 0.64, 'но выше базового уровня');
});

test('статистика: старые матчи весят меньше свежих', () => {
  const decaying = new RollingStats({ halfLifeDays: 30, prior: 0 });
  const flat = new RollingStats({ halfLifeDays: 0, prior: 0 });

  for (const stats of [decaying, flat]) {
    for (let i = 0; i < 10; i++) stats.observe('A', 'hard', at(i), sample(0.75, 0.4));
    for (let i = 0; i < 10; i++) stats.observe('A', 'hard', at(400 + i), sample(0.55, 0.4));
  }

  const options = { baseline: 0.64, minMatches: 1 };
  const withDecay = decaying.estimate('A', 'hard', at(410), options);
  const withoutDecay = flat.estimate('A', 'hard', at(410), options);

  // Свежая форма 55%: модель с затуханием обязана быть к ней ближе.
  assert.ok(withDecay.spw < withoutDecay.spw, 'затухание не сработало');
  assert.ok(Math.abs(withDecay.spw - 0.55) < Math.abs(withoutDecay.spw - 0.55));
});

/* ---------- прогноз ---------- */

test('прогноз: смесь по подающему первым симметрична', () => {
  const a = { spw: 0.68, rpw: 0.39 };
  const b = { spw: 0.62, rpw: 0.36 };
  const forecast = predictMatch(a, b, { tour: 'atp', surface: 'hard', bestOf: 3, baseline: 0.64 });

  const total = Object.values(forecast.matchScores).reduce((s, p) => s + p, 0);
  close(total, 1, 1e-12);
  assert.ok(forecast.aWins > 0.5, 'более сильный игрок должен быть фаворитом');

  // Смесь равна среднему двух вариантов подачи.
  const first = matchDistribution(forecast.pA, forecast.pB, { bestOf: 3, aServesFirst: true });
  const second = matchDistribution(forecast.pA, forecast.pB, { bestOf: 3, aServesFirst: false });
  close(forecast.aWins, (first.aWins + second.aWins) / 2, 1e-12);
});

test('прогноз: равные игроки дают ровно 50%', () => {
  const even = { spw: 0.64, rpw: 0.36 };
  const forecast = predictMatch(even, even, {
    tour: 'atp', surface: 'hard', bestOf: 3, baseline: 0.64,
  });
  // Единственная асимметрия — очередь подачи, а она усреднена.
  close(forecast.aWins, 0.5, 1e-12);
});

/* ---------- прогон ---------- */

const baseMatch = {
  date: at(0),
  tour: 'atp',
  surface: 'hard',
  bestOf: 3,
  winner: 'Alpha',
  loser: 'Beta',
  score: '6-4 6-3',
  serve: { winner: sample(0.7, 0.4), loser: sample(0.6, 0.35) },
};

test('прогон: матч не может быть предсказан по самому себе', () => {
  // Единственный матч: статистики до него нет, значит прогноза быть не должно.
  const { counters } = runBacktest([baseMatch], { minMatches: 1 });
  assert.equal(counters.predicted, 0);
  assert.equal(counters.skippedStats, 1);
});

test('прогон: прогноз появляется только после накопления истории', () => {
  const matches = Array.from({ length: 6 }, (_, i) => ({
    ...baseMatch,
    date: at(i),
    score: '6-4 6-3',
  }));

  const { counters } = runBacktest(matches, { minMatches: 3 });
  // Первые три матча уходят на накопление.
  assert.equal(counters.predicted, 3);
  assert.equal(counters.skippedStats, 3);
});

test('прогон: недоигранные матчи не попадают в оценку', () => {
  const matches = [
    { ...baseMatch, date: at(0) },
    { ...baseMatch, date: at(1), score: '6-3 RET' },
    { ...baseMatch, date: at(2) },
  ];

  const { counters } = runBacktest(matches, { minMatches: 1 });
  assert.equal(counters.skippedScore, 1);
  assert.equal(counters.total, 3);
});

test('прогон: порядок подачи входных данных не влияет на результат', () => {
  const matches = Array.from({ length: 8 }, (_, i) => ({ ...baseMatch, date: at(i) }));
  const forward = runBacktest(matches, { minMatches: 2 });
  const shuffled = runBacktest([...matches].reverse(), { minMatches: 2 });

  // Движок обязан сам упорядочивать по времени.
  assert.equal(forward.counters.predicted, shuffled.counters.predicted);
  close(
    brier(forward.predictions.matchWinner),
    brier(shuffled.predictions.matchWinner),
    1e-12,
  );
});

/* ---------- сквозная проверка на смоделированных данных ---------- */

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const binomial = (n, p, random) => {
  let hits = 0;
  for (let i = 0; i < n; i++) if (random() < p) hits += 1;
  return hits;
};

/** Выбор счёта из заданного распределения. */
function sampleLabel(distribution, random) {
  let roll = random();
  for (const entry of distribution) {
    roll -= entry.prob;
    if (roll <= 0) return entry;
  }
  return distribution.at(-1);
}

test('сквозная проверка: на данных с известными вероятностями модель откалибрована', () => {
  const random = mulberry32(12345);
  const baseline = 0.64;

  // Игроки с заданной силой подачи и приёма — это «истина», которую
  // движок должен восстановить, видя только очки в сыгранных матчах.
  // Имена намеренно расставлены не по силе: сторона A выбирается по алфавиту,
  // и если бы она всегда была сильнейшей, база выродилась бы в «A побеждает».
  const players = [
    { name: 'Delta', spw: 0.70, rpw: 0.40 },
    { name: 'Alpha', spw: 0.67, rpw: 0.38 },
    { name: 'Echo', spw: 0.64, rpw: 0.36 },
    { name: 'Bravo', spw: 0.61, rpw: 0.34 },
    { name: 'Charlie', spw: 0.58, rpw: 0.32 },
  ];

  // Счёт в архиве всегда записан со стороны победителя.
  const scoreFor = (label) => {
    const [x, y] = label.split('-').map(Number);
    const won = Math.max(x, y);
    const lost = Math.min(x, y);
    return [...Array(won).fill('6-4'), ...Array(lost).fill('4-6')].join(' ');
  };

  const matches = [];
  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];

        // Истинные вероятности очка на подаче в этой паре.
        const pA = baseline + (a.spw - baseline) - (b.rpw - (1 - baseline));
        const pB = baseline + (b.spw - baseline) - (a.rpw - (1 - baseline));

        const truth = matchDistribution(pA, pB, { bestOf: 3, aServesFirst: random() < 0.5 });
        const outcome = sampleLabel(truth.scores, random);
        const aWon = outcome.winner === 'A';

        const points = 70;
        matches.push({
          date: at(round * 7 + i + j),
          tour: 'atp',
          surface: 'hard',
          bestOf: 3,
          winner: aWon ? a.name : b.name,
          loser: aWon ? b.name : a.name,
          score: scoreFor(outcome.label),
          serve: {
            winner: aWon
              ? { spWon: binomial(points, pA, random), sp: points, rpWon: binomial(points, 1 - pB, random), rp: points }
              : { spWon: binomial(points, pB, random), sp: points, rpWon: binomial(points, 1 - pA, random), rp: points },
            loser: aWon
              ? { spWon: binomial(points, pB, random), sp: points, rpWon: binomial(points, 1 - pA, random), rp: points }
              : { spWon: binomial(points, pA, random), sp: points, rpWon: binomial(points, 1 - pB, random), rp: points },
          },
        });
      }
    }
  }

  const { predictions, counters } = runBacktest(matches, {
    minMatches: 10,
    halfLifeDays: 0,
    baselines: { atp: { hard: baseline } },
  });

  assert.ok(counters.predicted > 400, `мало прогнозов: ${counters.predicted}`);

  const score = brier(predictions.matchWinner);
  const error = calibrationError(predictions.matchWinner);

  assert.ok(score < 0.24, `Брайер не лучше монетки: ${score}`);
  assert.ok(skillScore(predictions.matchWinner) > 0.02, 'модель не несёт информации');
  // Данные порождены той же механикой, что и модель, поэтому расхождение
  // здесь измеряет только ошибку восстановления параметров по очкам.
  assert.ok(error < 0.06, `калибровка разъехалась: ${error}`);
});
