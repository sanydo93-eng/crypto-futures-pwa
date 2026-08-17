import test from 'node:test';
import assert from 'node:assert/strict';

import {
  logit, sigmoid, applyPlatt, fitPlatt,
  applyTemperature, fitTemperature, applyCalibration,
} from '../src/calibration.js';
import { calibrationError, logLoss } from '../src/backtest/metrics.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `ожидалось ${expected}, получено ${actual}`);

/* ---------- преобразования ---------- */

test('логит и сигмоида взаимно обратны', () => {
  for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) close(sigmoid(logit(p)), p, 1e-9);
});

test('единичная поправка Платта ничего не меняет', () => {
  for (const p of [0.05, 0.4, 0.9]) close(applyPlatt(p, { a: 1, b: 0 }), p, 1e-9);
  close(applyPlatt(0.7), 0.7, 1e-9);
});

test('поправка Платта растягивает и стягивает прогнозы', () => {
  // a > 1 отодвигает от середины, a < 1 придвигает к ней.
  assert.ok(applyPlatt(0.8, { a: 1.5, b: 0 }) > 0.8);
  assert.ok(applyPlatt(0.2, { a: 1.5, b: 0 }) < 0.2);
  assert.ok(applyPlatt(0.8, { a: 0.5, b: 0 }) < 0.8);
  assert.ok(applyPlatt(0.2, { a: 0.5, b: 0 }) > 0.2);
  // Середина остаётся серединой при нулевом сдвиге.
  close(applyPlatt(0.5, { a: 2, b: 0 }), 0.5, 1e-12);
});

/* ---------- подбор поправки Платта ---------- */

/** Выборка, где истинная вероятность — искажённая версия прогноза модели. */
function distorted(a0, b0, perBucket = 400) {
  const rows = [];
  for (let i = 1; i <= 19; i++) {
    const p = i / 20;
    const truth = sigmoid(a0 * logit(p) + b0);
    const ones = Math.round(truth * perBucket);
    for (let k = 0; k < perBucket; k++) rows.push({ p, outcome: k < ones ? 1 : 0 });
  }
  return rows;
}

test('подбор Платта восстанавливает известное искажение', () => {
  const rows = distorted(1.4, 0.2);
  const fit = fitPlatt(rows);

  assert.equal(fit.fitted, true);
  close(fit.a, 1.4, 0.08);
  close(fit.b, 0.2, 0.08);
});

test('подбор Платта чинит переуверенность', () => {
  // Модель говорит крайности, реальность ближе к середине.
  const rows = distorted(0.6, 0);
  const fit = fitPlatt(rows);
  assert.ok(fit.a < 0.8, `ожидалось стягивание, получено a=${fit.a}`);

  const corrected = rows.map((row) => ({ ...row, p: applyPlatt(row.p, fit) }));
  assert.ok(
    calibrationError(corrected) < calibrationError(rows) / 2,
    'поправка обязана заметно улучшить калибровку',
  );
});

test('на откалиброванных данных поправка почти единичная', () => {
  const rows = distorted(1, 0);
  const fit = fitPlatt(rows);
  close(fit.a, 1, 0.06);
  close(fit.b, 0, 0.06);
});

test('на короткой выборке поправка не подбирается', () => {
  // Иначе она выучит шум и на новых матчах сделает хуже.
  const fit = fitPlatt([{ p: 0.6, outcome: 1 }, { p: 0.4, outcome: 0 }]);
  assert.equal(fit.fitted, false);
  assert.equal(fit.a, 1);
  assert.equal(fit.b, 0);
});

/* ---------- температура ---------- */

test('температура: единица ничего не меняет, сумма сохраняется', () => {
  const probs = { '2-0': 0.5, '2-1': 0.3, '1-2': 0.15, '0-2': 0.05 };
  const same = applyTemperature(probs, 1);
  for (const [label, value] of Object.entries(probs)) close(same[label], value, 1e-12);

  for (const t of [0.5, 0.8, 1.5, 2.5]) {
    const scaled = applyTemperature(probs, t);
    close(Object.values(scaled).reduce((s, p) => s + p, 0), 1, 1e-9);
  }
});

test('температура: ниже единицы обостряет, выше — сглаживает', () => {
  const probs = { a: 0.6, b: 0.3, c: 0.1 };

  const sharp = applyTemperature(probs, 0.5);
  assert.ok(sharp.a > 0.6, 'фаворит должен усилиться');
  assert.ok(sharp.c < 0.1, 'аутсайдер — ослабнуть');

  const flat = applyTemperature(probs, 2);
  assert.ok(flat.a < 0.6);
  assert.ok(flat.c > 0.1);
});

test('температура: подбор восстанавливает известное искажение', () => {
  const base = { a: 0.55, b: 0.25, c: 0.12, d: 0.08 };
  const trueT = 0.7;
  const truth = applyTemperature(base, trueT);

  // Частоты исходов ровно по искажённому распределению.
  const rows = [];
  const total = 4000;
  for (const [label, p] of Object.entries(truth)) {
    for (let i = 0; i < Math.round(p * total); i++) rows.push({ probs: base, actual: label });
  }

  const fit = fitTemperature(rows);
  assert.equal(fit.fitted, true);
  close(fit.temperature, trueT, 0.06);
});

test('температура: подбор снижает лог-потерю', () => {
  const base = { a: 0.55, b: 0.25, c: 0.12, d: 0.08 };
  const truth = applyTemperature(base, 0.6);

  const rows = [];
  for (const [label, p] of Object.entries(truth)) {
    for (let i = 0; i < Math.round(p * 3000); i++) rows.push({ probs: base, actual: label });
  }

  const fit = fitTemperature(rows);
  const scored = (t) => rows.reduce(
    (sum, row) => sum - Math.log(applyTemperature(row.probs, t)[row.actual]), 0,
  ) / rows.length;

  assert.ok(scored(fit.temperature) < scored(1), 'подобранная температура должна быть лучше единичной');
});

/* ---------- применение целиком ---------- */

test('без поправки распределения проходят насквозь', () => {
  const input = {
    aWins: 0.7,
    matchScores: { '2-0': 0.5, '2-1': 0.2, '1-2': 0.2, '0-2': 0.1 },
    firstSetScores: { '6-4': 1 },
  };
  const output = applyCalibration(input, null);
  assert.deepEqual(output, input);
});

test('поправка применяется ко всем частям прогноза', () => {
  const input = {
    aWins: 0.7,
    matchScores: { '2-0': 0.5, '2-1': 0.2, '1-2': 0.2, '0-2': 0.1 },
    firstSetScores: { '6-4': 0.6, '6-3': 0.4 },
  };
  const output = applyCalibration(input, {
    winner: { a: 1.3, b: 0 },
    matchScore: { temperature: 0.8 },
    firstSetScore: { temperature: 1.2 },
  });

  assert.ok(output.aWins > input.aWins, 'растяжение должно усилить фаворита');
  close(Object.values(output.matchScores).reduce((s, p) => s + p, 0), 1, 1e-9);
  close(Object.values(output.firstSetScores).reduce((s, p) => s + p, 0), 1, 1e-9);
});

test('поправка, обученная на смещённых данных, улучшает прогноз на новых', () => {
  // Обучающая и проверочная половины порождены одним и тем же искажением —
  // именно тот случай, когда поправку и стоит применять.
  const train = distorted(1.5, 0.1, 300);
  const holdout = distorted(1.5, 0.1, 200);

  const fit = fitPlatt(train);
  const corrected = holdout.map((row) => ({ ...row, p: applyPlatt(row.p, fit) }));

  assert.ok(logLoss(corrected) < logLoss(holdout), 'на новых данных должно стать лучше');
});
