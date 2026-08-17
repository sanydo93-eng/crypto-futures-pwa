/**
 * Работа с коэффициентами: снятие маржи, расчёт преимущества и ставки по Келли.
 */

/**
 * Снятие маржи букмекера («девиг»).
 *
 * Сумма 1/коэффициент по всем исходам больше единицы — разница и есть маржа.
 * На точном счёте она обычно 15–25%, поэтому способ её снятия сильно влияет
 * на результат.
 *
 * - 'power' (по умолчанию): p_i = (1/o_i)^k, где k подбирается так, чтобы сумма
 *   дала единицу. Учитывает fav-longshot bias — маловероятные исходы переоценены
 *   сильнее фаворитов. Для рынка с десятком исходов это заметно точнее.
 * - 'proportional': простое деление на сумму. Растягивает маржу поровну и
 *   систематически завышает шансы аутсайдеров.
 *
 * @param {number[]} decimalOdds десятичные коэффициенты по всем исходам рынка
 * @param {'power'|'proportional'} method
 * @returns {{probabilities:number[], overround:number, exponent:number|null}}
 */
export function devig(decimalOdds, method = 'power') {
  if (!Array.isArray(decimalOdds) || decimalOdds.length === 0) {
    throw new TypeError('devig: нужен непустой массив коэффициентов');
  }
  if (decimalOdds.some((o) => !(o > 1))) {
    throw new RangeError('devig: коэффициенты должны быть строго больше 1');
  }

  const raw = decimalOdds.map((o) => 1 / o);
  const overround = raw.reduce((s, r) => s + r, 0) - 1;

  if (method === 'proportional') {
    const total = overround + 1;
    return { probabilities: raw.map((r) => r / total), overround, exponent: null };
  }

  // Подбор показателя k бисекцией: сумма r_i^k строго убывает по k, так как
  // каждое r_i меньше единицы. При k→0 сумма стремится к числу исходов, при
  // больших k — к нулю, поэтому корень всегда внутри отрезка. Границы берём
  // с запасом в обе стороны: рынок бывает и с отрицательной маржой (сумма
  // вероятностей меньше единицы), там нужен k < 1.
  const sumAt = (k) => raw.reduce((s, r) => s + r ** k, 0);
  let lo = 1e-9;
  let hi = 64;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }

  const k = (lo + hi) / 2;
  const probabilities = raw.map((r) => r ** k);
  const total = probabilities.reduce((s, p) => s + p, 0);

  return {
    probabilities: probabilities.map((p) => p / total),
    overround,
    exponent: k,
  };
}

/**
 * Математическое ожидание на единицу ставки.
 * Положительное — ставка выгодна ПРИ УСЛОВИИ, что модель права.
 */
export function edge(modelProbability, decimalOdds) {
  return modelProbability * decimalOdds - 1;
}

/**
 * Доля банка по критерию Келли. Отрицательные значения обрезаются в ноль:
 * ставок против рынка эта система не делает.
 *
 * Полный Келли на практике слишком агрессивен — ошибка модели бьёт по банку
 * квадратично, поэтому по умолчанию берётся четверть.
 */
export function kelly(modelProbability, decimalOdds, fraction = 0.25) {
  const full = (modelProbability * decimalOdds - 1) / (decimalOdds - 1);
  return Math.max(0, full * fraction);
}
