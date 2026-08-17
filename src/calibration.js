/**
 * Поправка вероятностей модели по историческим данным.
 *
 * Зачем это нужно. Параметры модели оцениваются по конечной выборке, а значит
 * с шумом. Шум в параметрах систематически стягивает прогнозы к середине:
 * модель говорит 75%, а случается 78%. Это недоуверенность, и она не лечится
 * улучшением самой модели — её надо измерить и снять отдельным слоем.
 *
 * Два инструмента:
 *   - шкалирование Платта для бинарных исходов (победа в матче);
 *   - температура для распределения по счетам.
 *
 * Оба обучаются на прошлом и применяются к будущему. Обучать и проверять на
 * одних данных бессмысленно: поправка подгонится под шум и на новых матчах
 * сделает хуже.
 */

const EPS = 1e-12;
const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));

export const logit = (p) => Math.log(clip(p) / (1 - clip(p)));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/* ------------------------------------------------------------------ */
/* Бинарные исходы: шкалирование Платта                                */
/* ------------------------------------------------------------------ */

export const applyPlatt = (p, { a = 1, b = 0 } = {}) => sigmoid(a * logit(p) + b);

const plattLoss = (predictions, a, b) => {
  let total = 0;
  for (const { p, outcome } of predictions) {
    const q = clip(applyPlatt(p, { a, b }));
    total -= outcome * Math.log(q) + (1 - outcome) * Math.log(1 - q);
  }
  return total / predictions.length;
};

/**
 * Подбор поправки p -> sigmoid(a * logit(p) + b).
 *
 * a > 1 означает, что модель была недоуверенной и прогнозы надо растянуть от
 * середины; a < 1 — переуверенной и их надо стянуть. b сдвигает общий уровень.
 *
 * Оптимизация покоординатная: задача выпуклая по (a, b), а размерность равна
 * двум, поэтому городить градиентный спуск незачем.
 */
export function fitPlatt(predictions, options = {}) {
  const { iterations = 40, minSamples = 100 } = options;

  // На короткой выборке поправка выучит шум, а не смещение.
  if (predictions.length < minSamples) return { a: 1, b: 0, fitted: false, samples: predictions.length };

  let a = 1;
  let b = 0;
  let stepA = 0.5;
  let stepB = 0.5;

  for (let i = 0; i < iterations; i++) {
    let improved = false;

    for (const candidate of [a - stepA, a + stepA]) {
      if (candidate > 0 && plattLoss(predictions, candidate, b) < plattLoss(predictions, a, b)) {
        a = candidate;
        improved = true;
      }
    }
    for (const candidate of [b - stepB, b + stepB]) {
      if (plattLoss(predictions, a, candidate) < plattLoss(predictions, a, b)) {
        b = candidate;
        improved = true;
      }
    }

    if (!improved) {
      stepA /= 2;
      stepB /= 2;
      if (stepA < 1e-4 && stepB < 1e-4) break;
    }
  }

  return { a, b, fitted: true, samples: predictions.length, loss: plattLoss(predictions, a, b) };
}

/* ------------------------------------------------------------------ */
/* Распределения: температура                                          */
/* ------------------------------------------------------------------ */

/**
 * Температурное шкалирование распределения.
 * T < 1 обостряет распределение, T > 1 сглаживает, T = 1 не меняет ничего.
 */
export function applyTemperature(probs, temperature = 1) {
  if (!(temperature > 0) || temperature === 1) return { ...probs };

  const power = 1 / temperature;
  const scaled = {};
  let total = 0;

  for (const [label, p] of Object.entries(probs)) {
    const value = clip(p) ** power;
    scaled[label] = value;
    total += value;
  }

  if (total === 0) return { ...probs };
  for (const label of Object.keys(scaled)) scaled[label] /= total;
  return scaled;
}

const temperatureLoss = (predictions, temperature) => {
  let total = 0;
  for (const { probs, actual } of predictions) {
    const scaled = applyTemperature(probs, temperature);
    total -= Math.log(clip(scaled[actual] ?? 0));
  }
  return total / predictions.length;
};

/**
 * Подбор температуры троичным поиском: потеря по T унимодальна,
 * поэтому этого достаточно и никакие производные не нужны.
 */
export function fitTemperature(predictions, options = {}) {
  const { low = 0.3, high = 3, iterations = 60, minSamples = 100 } = options;

  if (predictions.length < minSamples) {
    return { temperature: 1, fitted: false, samples: predictions.length };
  }

  let lo = low;
  let hi = high;
  for (let i = 0; i < iterations; i++) {
    const third = (hi - lo) / 3;
    const left = lo + third;
    const right = hi - third;
    if (temperatureLoss(predictions, left) < temperatureLoss(predictions, right)) hi = right;
    else lo = left;
  }

  const temperature = (lo + hi) / 2;
  return {
    temperature,
    fitted: true,
    samples: predictions.length,
    loss: temperatureLoss(predictions, temperature),
  };
}

/* ------------------------------------------------------------------ */

/** Готовая поправка, которую можно сохранить и применять в бою. */
export function applyCalibration({ aWins, matchScores, firstSetScores }, calibration) {
  if (!calibration) return { aWins, matchScores, firstSetScores };

  return {
    aWins: calibration.winner ? applyPlatt(aWins, calibration.winner) : aWins,
    matchScores: applyTemperature(matchScores, calibration.matchScore?.temperature ?? 1),
    firstSetScores: applyTemperature(firstSetScores, calibration.firstSetScore?.temperature ?? 1),
  };
}
