import { devig, edge, kelly } from './odds.js';

/**
 * Сравнение вероятностей модели с котировками — общая часть для всех видов спорта.
 */

export const DEFAULT_SETTINGS = {
  minEdge: 0.05,
  minProbability: 0.02,
  devigMethod: 'power',
  kellyFraction: 0.25,
};

/**
 * Маржа снимается по рынку целиком, поэтому коэффициенты должны приходить
 * полным набором исходов — иначе «справедливые» цены поедут.
 *
 * @param {string} marketName
 * @param {Record<string, number>} odds исход -> десятичный коэффициент
 * @param {Record<string, number>} modelProbabilities исход -> вероятность модели
 */
export function compareMarket(marketName, odds, modelProbabilities, settings = DEFAULT_SETTINGS) {
  const outcomes = Object.keys(odds ?? {});
  if (outcomes.length === 0) return [];

  const { probabilities, overround } = devig(
    outcomes.map((key) => odds[key]),
    settings.devigMethod,
  );

  return outcomes.map((outcome, i) => {
    const modelProb = modelProbabilities[outcome] ?? 0;
    const marketOdds = odds[outcome];

    return {
      market: marketName,
      outcome,
      modelProb,
      marketProb: probabilities[i],
      marketOdds,
      fairOdds: modelProb > 0 ? 1 / modelProb : Infinity,
      overround,
      edge: edge(modelProb, marketOdds),
      stake: kelly(modelProb, marketOdds, settings.kellyFraction),
    };
  });
}

/**
 * Отбор сигналов. Слишком редкие исходы отсекаются: там модель наименее
 * надёжна, а ошибка в третьем знаке даёт фиктивно огромное преимущество.
 */
export function selectSignals(rows, settings = DEFAULT_SETTINGS) {
  return rows
    .filter((row) => row.edge >= settings.minEdge && row.modelProb >= settings.minProbability)
    .sort((a, b) => b.edge - a.edge);
}

export const withDefaults = (options = {}) => ({ ...DEFAULT_SETTINGS, ...options });
