import test from 'node:test';
import assert from 'node:assert/strict';

import { poissonPmf, dixonColesTau, clampRho, scoreGrid } from '../src/football/poisson.js';
import { firstHalfMarkets } from '../src/football/markets.js';
import { buildStrengths } from '../src/football/strength.js';
import { evaluateFixture, modelFixture } from '../src/football/signals.js';
import { demoHistory } from '../src/providers/football/mock.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `ожидалось ${expected}, получено ${actual}`,
  );

const sum = (values) => values.reduce((a, b) => a + b, 0);

/* ---------- Пуассон ---------- */

test('Пуассон: совпадает с аналитическими значениями', () => {
  close(poissonPmf(0, 1), Math.exp(-1));
  close(poissonPmf(1, 1), Math.exp(-1));
  close(poissonPmf(2, 1), Math.exp(-1) / 2);
  close(poissonPmf(0, 0.7), Math.exp(-0.7));
});

test('Пуассон: распределение суммируется в единицу', () => {
  const total = sum(Array.from({ length: 40 }, (_, k) => poissonPmf(k, 1.3)));
  close(total, 1, 1e-12);
});

test('Пуассон: вырожденные аргументы', () => {
  assert.equal(poissonPmf(-1, 1), 0);
  assert.equal(poissonPmf(1.5, 1), 0);
  assert.equal(poissonPmf(0, 0), 1);
});

/* ---------- Диксон — Коулз ---------- */

test('Диксон — Коулз: при rho=0 поправки нет', () => {
  for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 3]]) {
    close(dixonColesTau(x, y, 1.2, 0.9, 0), 1);
  }
});

test('Диксон — Коулз: поправка трогает только низкие счета', () => {
  const tau = (x, y) => dixonColesTau(x, y, 1.2, 0.9, -0.1);
  assert.ok(tau(0, 0) > 1, '0:0 должен получить больше веса');
  assert.ok(tau(1, 1) > 1, '1:1 тоже');
  assert.ok(tau(1, 0) < 1, '1:0 — меньше');
  assert.ok(tau(0, 1) < 1, '0:1 — меньше');
  close(tau(2, 1), 1, 1e-12);
  close(tau(3, 3), 1, 1e-12);
});

test('Диксон — Коулз: rho зажимается в допустимую область', () => {
  // Слишком большой по модулю rho увёл бы вероятности в минус.
  const rho = clampRho(-5, 0.7, 0.5);
  assert.ok(rho >= -1 / 0.7, `rho вышел за границу: ${rho}`);
  assert.ok(dixonColesTau(0, 1, 0.7, 0.5, rho) >= 0);
  assert.ok(dixonColesTau(1, 0, 0.7, 0.5, rho) >= 0);
});

test('сетка счетов: суммируется в единицу', () => {
  for (const rho of [0, -0.1, -0.05]) {
    const { grid } = scoreGrid(0.85, 0.65, { rho });
    close(sum(grid.flat()), 1, 1e-12);
  }
});

test('сетка счетов: при rho=0 совпадает с произведением независимых', () => {
  const { grid } = scoreGrid(0.8, 0.6, { rho: 0, maxGoals: 12 });
  // Нормировка по обрезанной сетке вносит крошечную поправку, отсюда допуск.
  close(grid[1][2], poissonPmf(1, 0.8) * poissonPmf(2, 0.6), 1e-6);
});

test('сетка счетов: поправка поднимает 0:0 относительно независимой модели', () => {
  const plain = scoreGrid(0.85, 0.65, { rho: 0 }).grid[0][0];
  const corrected = scoreGrid(0.85, 0.65, { rho: -0.1 }).grid[0][0];
  assert.ok(corrected > plain, 'ради этого поправка и вводится');
});

/* ---------- рынки первого тайма ---------- */

test('рынки: каждый набор исходов полон', () => {
  const m = firstHalfMarkets(0.75, 0.6);
  close(m.goal.yes + m.goal.no, 1, 1e-9);
  close(m.total15.over + m.total15.under, 1, 1e-9);
  close(m.total25.over + m.total25.under, 1, 1e-9);
  close(m.result['1'] + m.result.X + m.result['2'], 1, 1e-9);
});

test('рынки: «нет гола» — это ровно счёт 0:0', () => {
  const m = firstHalfMarkets(0.7, 0.55);
  const nilNil = m.exactScore.find((e) => e.outcome === '0-0');
  close(m.goal.no, nilNil.prob, 1e-9);
});

test('рынки: чем больше ожидаемых голов, тем вероятнее гол', () => {
  let previous = 0;
  for (const lambda of [0.3, 0.5, 0.8, 1.2, 1.8]) {
    const chance = firstHalfMarkets(lambda, lambda * 0.8).goal.yes;
    assert.ok(chance > previous, `немонотонность на λ=${lambda}`);
    previous = chance;
  }
});

test('рынки: перевес хозяев отражается в исходе тайма', () => {
  const m = firstHalfMarkets(1.1, 0.4);
  assert.ok(m.result['1'] > m.result['2'], 'сильные хозяева должны чаще вести к перерыву');
});

test('рынки: значения правдоподобны для типичного матча', () => {
  // Ориентир по реальным лигам: гол в первом тайме примерно в 60-70% матчей.
  const chance = firstHalfMarkets(0.68, 0.55).goal.yes;
  assert.ok(chance > 0.6 && chance < 0.75, `нереалистичная величина ${chance}`);
});

/* ---------- рейтинги команд ---------- */

const TWO_MATCHES = [
  { home: 'A', away: 'B', hg: 2, ag: 0, hthg: 1, htag: 0 },
  { home: 'B', away: 'A', hg: 1, ag: 1, hthg: 0, htag: 1 },
];

test('рейтинги: средние по лиге считаются точно', () => {
  const s = buildStrengths(TWO_MATCHES);
  close(s.league.full.home, 1.5);
  close(s.league.full.away, 0.5);
  close(s.league.firstHalf.home, 0.5);
  close(s.league.firstHalf.away, 0.5);
  assert.equal(s.size, 2);
});

test('рейтинги: битые строки отбрасываются', () => {
  // Голов к перерыву не может быть больше, чем в матче.
  const dirty = [...TWO_MATCHES, { home: 'C', away: 'D', hg: 1, ag: 0, hthg: 3, htag: 0 }];
  assert.equal(buildStrengths(dirty).size, 2);
  assert.throws(() => buildStrengths([]), /ни одного пригодного матча/);
});

test('рейтинги: незнакомая команда получает средний уровень лиги', () => {
  const s = buildStrengths(TWO_MATCHES);
  const estimate = s.expectedGoals('нет такой', 'и такой нет');
  assert.equal(estimate.known, false);
  close(estimate.lambdaHome, s.league.firstHalf.home);
  close(estimate.lambdaAway, s.league.firstHalf.away);
});

test('рейтинги: малая выборка стягивается к среднему по лиге', () => {
  const s = buildStrengths(TWO_MATCHES, { prior: 100 });
  const estimate = s.expectedGoals('A', 'B');
  // При огромном prior наблюдения почти не влияют.
  close(estimate.lambdaHome, s.league.firstHalf.home, 0.05);
});

test('рейтинги: сильная атака поднимает ожидаемые голы', () => {
  const strengths = buildStrengths(demoHistory(), { prior: 2 });
  const strong = strengths.expectedGoals('Северный ФК', 'Дубрава');
  const weak = strengths.expectedGoals('Дубрава', 'Северный ФК');
  assert.ok(strong.lambdaHome > weak.lambdaHome, 'атака должна отражаться в оценке');
});

test('рейтинги: сохранение и восстановление не теряют данные', () => {
  const original = buildStrengths(demoHistory());
  const restored = new (Object.getPrototypeOf(original).constructor)(
    JSON.parse(JSON.stringify(original)),
  );
  assert.equal(restored.size, original.size);
  close(
    restored.expectedGoals('Северный ФК', 'Приморье').lambdaHome,
    original.expectedGoals('Северный ФК', 'Приморье').lambdaHome,
  );
});

test('демо-история: пригодна для модели и детерминирована', () => {
  const first = demoHistory();
  const second = demoHistory();
  assert.deepEqual(first, second, 'демо обязано быть воспроизводимым');

  for (const m of first) {
    assert.ok(m.hthg <= m.hg, 'голов к перерыву не может быть больше итоговых');
    assert.ok(m.htag <= m.ag);
  }
});

/* ---------- сигналы ---------- */

const FIXTURE = {
  id: 'f1',
  home: 'A',
  away: 'B',
  lambdaHome: 0.85,
  lambdaAway: 0.65,
  markets: { firstHalfGoal: { yes: 1.24, no: 4.0 } },
};

test('сигналы: справедливый рынок не порождает сигналов', () => {
  const model = modelFixture(FIXTURE);
  const fair = {
    ...FIXTURE,
    markets: { firstHalfGoal: { yes: 1 / model.goal.yes, no: 1 / model.goal.no } },
  };

  const result = evaluateFixture(fair);
  assert.equal(result.signals.length, 0);
  for (const row of result.markets) close(row.edge, 0, 1e-9);
});

test('сигналы: завышенный коэффициент попадает в отбор', () => {
  const generous = { ...FIXTURE, markets: { firstHalfGoal: { yes: 1.6, no: 4.0 } } };
  const signal = evaluateFixture(generous).signals.find((s) => s.outcome === 'yes');

  assert.ok(signal, 'ожидался сигнал на завышенном исходе');
  assert.ok(signal.edge > 0.2, `слабое преимущество: ${signal.edge}`);
  assert.ok(signal.stake > 0);
});

test('сигналы: без ожидаемых голов и без справочника — понятная ошибка', () => {
  assert.throws(
    () => modelFixture({ id: 'x', home: 'A', away: 'B' }),
    /нет ни ожидаемых голов, ни справочника/,
  );
});

test('сигналы: имена команд берутся из справочника, когда голы не заданы', () => {
  const strengths = buildStrengths(demoHistory());
  const model = modelFixture({ id: 'x', home: 'Северный ФК', away: 'Дубрава' }, strengths);
  assert.equal(model.known, true);
  assert.ok(model.goal.yes > 0 && model.goal.yes < 1);
});
