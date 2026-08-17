import { firstHalfMarkets, marketProbabilities } from './markets.js';
import { compareMarket, selectSignals, withDefaults } from '../market.js';

/**
 * Модель одного футбольного матча по первому тайму.
 *
 * @param {object} fixture матч с ожидаемыми голами или именами команд
 * @param {import('./strength.js').TeamStrengths} [strengths]
 */
export function modelFixture(fixture, strengths = null) {
  let lambdaHome = fixture.lambdaHome;
  let lambdaAway = fixture.lambdaAway;
  let known = true;

  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) {
    if (!strengths) {
      throw new Error(`Матч ${fixture.id}: нет ни ожидаемых голов, ни справочника команд`);
    }
    const estimate = strengths.expectedGoals(fixture.home, fixture.away, 'firstHalf');
    lambdaHome = estimate.lambdaHome;
    lambdaAway = estimate.lambdaAway;
    known = estimate.known;
  }

  return { ...firstHalfMarkets(lambdaHome, lambdaAway, { rho: fixture.rho ?? -0.1 }), known };
}

export function evaluateFixture(fixture, options = {}, strengths = null) {
  const settings = withDefaults(options);
  const model = modelFixture(fixture, strengths);
  const probabilities = marketProbabilities(model);

  const markets = Object.entries(probabilities).flatMap(([name, modelProbs]) =>
    compareMarket(name, fixture.markets?.[name], modelProbs, settings),
  );

  return {
    sport: 'football',
    match: {
      id: fixture.id,
      competition: fixture.competition,
      startsAt: fixture.startsAt ?? null,
      teams: [fixture.home, fixture.away],
      knownTeams: model.known,
    },
    model: {
      lambdaHome: model.lambdaHome,
      lambdaAway: model.lambdaAway,
      expectedGoals: model.expectedGoals,
      goalChance: model.goal.yes,
      result: model.result,
      exactScore: model.exactScore.slice(0, 6),
    },
    markets,
    signals: selectSignals(markets, settings),
  };
}

export const evaluateAllFixtures = (fixtures, options = {}, strengths = null) =>
  fixtures.map((fixture) => evaluateFixture(fixture, options, strengths));
