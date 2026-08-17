import { serveProbabilities } from './serve.js';
import { matchDistribution } from './match.js';
import { compareMarket, selectSignals, withDefaults } from '../market.js';

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

/**
 * Полный разбор матча: модель, сравнение с рынком, отобранные сигналы.
 */
export function evaluateMatch(match, options = {}) {
  const settings = withDefaults(options);
  const model = modelMatch(match);

  const markets = [
    ...compareMarket(
      'correctScore',
      match.markets?.correctScore,
      toProbabilityMap(model.scores),
      settings,
    ),
    ...compareMarket(
      'firstSetScore',
      match.markets?.firstSetScore,
      toProbabilityMap(model.firstSet, (s) => `${s.a}-${s.b}`),
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
      aWins: model.aWins,
      scores: model.scores,
    },
    markets,
    signals: selectSignals(markets, settings),
  };
}

export const evaluateAll = (matches, options = {}) =>
  matches.map((match) => evaluateMatch(match, options));
