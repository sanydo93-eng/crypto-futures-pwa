import { serveProbabilities } from './model/serve.js';
import { matchDistribution } from './model/match.js';
import { devig, edge, kelly } from './odds.js';

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

/**
 * Сравнение модели с рынком по одному набору коэффициентов.
 *
 * Маржа снимается по всему рынку целиком, поэтому коэффициенты должны
 * приходить полным набором исходов — иначе «справедливые» цены поедут.
 */
function compareMarket({ marketName, odds, modelProbabilities, options }) {
  const outcomes = Object.keys(odds);
  if (outcomes.length === 0) return [];

  const { probabilities: marketProbs, overround } = devig(
    outcomes.map((key) => odds[key]),
    options.devigMethod,
  );

  return outcomes.map((outcome, i) => {
    const modelProb = modelProbabilities[outcome] ?? 0;
    const marketOdds = odds[outcome];

    return {
      market: marketName,
      outcome,
      modelProb,
      marketProb: marketProbs[i],
      marketOdds,
      fairOdds: modelProb > 0 ? 1 / modelProb : Infinity,
      overround,
      edge: edge(modelProb, marketOdds),
      stake: kelly(modelProb, marketOdds, options.kellyFraction),
    };
  });
}

function toProbabilityMap(scores, keyFn = (s) => s.label) {
  return Object.fromEntries(scores.map((s) => [keyFn(s), s.prob]));
}

/**
 * Полный разбор матча: модель, сравнение с рынком, отобранные сигналы.
 */
export function evaluateMatch(match, options = {}) {
  const settings = {
    minEdge: 0.05,
    minProbability: 0.02,
    devigMethod: 'power',
    kellyFraction: 0.25,
    ...options,
  };

  const model = modelMatch(match);

  const markets = [];
  if (match.markets?.correctScore) {
    markets.push(
      ...compareMarket({
        marketName: 'correctScore',
        odds: match.markets.correctScore,
        modelProbabilities: toProbabilityMap(model.scores),
        options: settings,
      }),
    );
  }
  if (match.markets?.firstSetScore) {
    markets.push(
      ...compareMarket({
        marketName: 'firstSetScore',
        odds: match.markets.firstSetScore,
        modelProbabilities: toProbabilityMap(model.firstSet, (s) => `${s.a}-${s.b}`),
        options: settings,
      }),
    );
  }

  // Слишком редкие исходы отсекаются: там модель наименее надёжна, а ошибка
  // в третьем знаке даёт фиктивно огромное преимущество.
  const signals = markets
    .filter((m) => m.edge >= settings.minEdge && m.modelProb >= settings.minProbability)
    .sort((x, y) => y.edge - x.edge);

  return {
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
    signals,
  };
}

export function evaluateAll(matches, options = {}) {
  return matches.map((m) => evaluateMatch(m, options));
}
