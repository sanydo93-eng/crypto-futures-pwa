/**
 * Метрики качества прогноза.
 *
 * Точность («угадал / не угадал») для ставок бесполезна: важно, чтобы
 * заявленные 70% случались именно в 70% случаев. Поэтому здесь оценки
 * калибровки, а не доля попаданий.
 */

const EPS = 1e-12;
const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));

/**
 * Средний квадрат ошибки вероятности. Чем меньше, тем лучше.
 * Ориентир: постоянный прогноз 50% даёт ровно 0.25.
 */
export function brier(predictions) {
  if (predictions.length === 0) return null;
  const total = predictions.reduce((sum, { p, outcome }) => sum + (p - outcome) ** 2, 0);
  return total / predictions.length;
}

/** Логарифмическая потеря. Ориентир: прогноз 50% даёт ln 2 ≈ 0.693. */
export function logLoss(predictions) {
  if (predictions.length === 0) return null;
  const total = predictions.reduce((sum, { p, outcome }) => {
    const q = clip(p);
    return sum - (outcome * Math.log(q) + (1 - outcome) * Math.log(1 - q));
  }, 0);
  return total / predictions.length;
}

/** Многоклассовая логарифмическая потеря — для распределения по счетам. */
export function multiclassLogLoss(predictions) {
  if (predictions.length === 0) return null;
  const total = predictions.reduce(
    (sum, { probs, actual }) => sum - Math.log(clip(probs[actual] ?? 0)),
    0,
  );
  return total / predictions.length;
}

/**
 * Насколько модель лучше постоянного прогноза «средняя частота события».
 * Ноль — модель не несёт информации, единица — идеальный прогноз,
 * отрицательное значение — модель хуже, чем ничего.
 */
export function skillScore(predictions) {
  if (predictions.length === 0) return null;
  const base = predictions.reduce((sum, { outcome }) => sum + outcome, 0) / predictions.length;
  const reference = predictions.reduce((sum, { outcome }) => sum + (base - outcome) ** 2, 0)
    / predictions.length;
  if (reference === 0) return null;
  return 1 - brier(predictions) / reference;
}

/**
 * Таблица калибровки: прогнозы разложены по корзинам, в каждой сравнивается
 * средняя обещанная вероятность с реально случившейся частотой.
 * Расхождение здесь — прямая причина проигрыша на рынке с высокой маржой.
 */
export function calibration(predictions, buckets = 10) {
  const table = Array.from({ length: buckets }, (_, i) => ({
    from: i / buckets,
    to: (i + 1) / buckets,
    count: 0,
    predicted: 0,
    observed: 0,
  }));

  for (const { p, outcome } of predictions) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor(p * buckets)));
    const row = table[index];
    row.count += 1;
    row.predicted += p;
    row.observed += outcome;
  }

  return table
    .filter((row) => row.count > 0)
    .map((row) => ({
      ...row,
      predicted: row.predicted / row.count,
      observed: row.observed / row.count,
    }));
}

/**
 * Средняя абсолютная ошибка калибровки, взвешенная по числу наблюдений.
 * Одно число вместо таблицы — удобно сравнивать варианты модели.
 */
export function calibrationError(predictions, buckets = 10) {
  const table = calibration(predictions, buckets);
  const total = table.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;

  return table.reduce(
    (sum, row) => sum + (row.count / total) * Math.abs(row.predicted - row.observed),
    0,
  );
}

/**
 * Сравнение предсказанной частоты каждого исхода с наблюдённой по всей выборке.
 * Для точного счёта это главная проверка: модель обещает пилообразное
 * распределение по счетам, и здесь видно, есть ли эта пила в реальности.
 */
export function outcomeFrequencies(predictions) {
  const rows = new Map();

  for (const { probs, actual } of predictions) {
    for (const [label, p] of Object.entries(probs)) {
      if (!rows.has(label)) rows.set(label, { label, predicted: 0, observed: 0 });
      rows.get(label).predicted += p;
    }
    if (!rows.has(actual)) rows.set(actual, { label: actual, predicted: 0, observed: 0 });
    rows.get(actual).observed += 1;
  }

  const n = predictions.length || 1;
  return [...rows.values()]
    .map((row) => ({
      label: row.label,
      predicted: row.predicted / n,
      observed: row.observed / n,
      count: row.observed,
    }))
    .sort((a, b) => b.observed - a.observed);
}
