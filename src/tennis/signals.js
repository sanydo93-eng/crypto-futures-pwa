import { serveProbabilities } from './serve.js';
import { matchDistribution } from './match.js';
import { compareMarket, selectSignals, withDefaults } from '../market.js';
import { applyCalibration } from '../calibration.js';

/**
 * Прогон модели по одному матчу: от статистики игроков до распределения счёта.
 */
export function modelMatch(match) {
  const { pA, pB, baseline } = serveProbabilities(match.players.a, match.players.b, {
    tour: match.tour,
    surface: match.surface,
  });

  const distribution = matchDistribution(pA, pB, {
    bestOf: match.bestOf ?? 3,
    aServesFirst: match.aServesFirst ?? true,
  });

  return { pA, pB, baseline, ...distribution };
}

const toProbabilityMap = (scores, keyFn = (s) => s.label) =>
  Object.fromEntries(scores.map((s) => [keyFn(s), s.prob]));

const toSortedScores = (probs) =>
  Object.entries(probs)
    .map(([label, prob]) => {
      const [a, b] = label.split('-').map(Number);
      return { label, a, b, prob, winner: a > b ? 'A' : 'B' };
    })
    .sort((x, y) => y.prob - x.prob);

/**
 * Полный разбор матча: модель, поправка, сравнение с рынком, сигналы.
 *
 * Поправка вероятностей подбирается бэктестом и подключается через настройки.
 * Она применяется до сравнения с рынком — иначе преимущество считалось бы по
 * непоправленным числам, и весь смысл поправки терялся.
 */
export function evaluateMatch(match, options = {}) {
  const settings = withDefaults(options);
  const model = modelMatch(match);

  const adjusted = applyCalibration(
    {
      aWins: model.aWins,
      matchScores: toProbabilityMap(model.scores),
      firstSetScores: toProbabilityMap(model.firstSet, (s) => `${s.a}-${s.b}`),
    },
    settings.calibration,
  );

  const markets = [
    ...compareMarket('correctScore', match.markets?.correctScore, adjusted.matchScores, settings),
    ...compareMarket(
      'firstSetScore',
      match.markets?.firstSetScore,
      adjusted.firstSetScores,
      settings,
    ),
  ];

  return {
    sport: 'tennis',
    match: {
      id: match.id,
      tournament: match.tournament,
      surface: match.surface,
      tour: match.tour,
      startsAt: match.startsAt,
      players: [match.players.a.name, match.players.b.name],
    },
    model: {
      pA: model.pA,
      pB: model.pB,
      aWins: adjusted.aWins,
      calibrated: Boolean(settings.calibration),
      scores: toSortedScores(adjusted.matchScores),
      firstSet: toSortedScores(adjusted.firstSetScores),
    },
    markets,
    signals: selectSignals(markets, settings),
  };
}

export const evaluateAll = (matches, options = {}) =>
  matches.map((match) => evaluateMatch(match, options));
