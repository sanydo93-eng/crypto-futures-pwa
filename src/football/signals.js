import { firstHalfMarkets, fullMatchMarkets, marketProbabilities } from './markets.js';
import { compareMarket, selectSignals, withDefaults } from '../market.js';

/**
 * Модель одного футбольного матча по первому тайму.
 *
 * @param {object} fixture матч с ожидаемыми голами или именами команд
 * @param {import('./strength.js').TeamStrengths} [strengths]
 */
// Доля голов, забиваемых до перерыва. Используется только когда полные
// ожидаемые голы не заданы напрямую.
const FIRST_HALF_SHARE = 0.45;

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

    // Для матча целиком у справочника есть собственные данные — они точнее,
    // чем пересчёт из тайма по средней доле.
    const fullEstimate = strengths.expectedGoals(fixture.home, fixture.away, 'full');
    fixture = {
      ...fixture,
      fullLambdaHome: fullEstimate.lambdaHome,
      fullLambdaAway: fullEstimate.lambdaAway,
    };
  }

  const rho = fixture.rho ?? -0.1;
  const half = firstHalfMarkets(lambdaHome, lambdaAway, { rho });

  // Ожидаемые голы за матч выводим из таймовых, если справочник дал только их.
  // Доля голов до перерыва устойчива и близка к 45%.
  const fullHome = Number.isFinite(fixture.fullLambdaHome)
    ? fixture.fullLambdaHome
    : lambdaHome / FIRST_HALF_SHARE;
  const fullAway = Number.isFinite(fixture.fullLambdaAway)
    ? fixture.fullLambdaAway
    : lambdaAway / FIRST_HALF_SHARE;

  return {
    ...half,
    full: fullMatchMarkets(fullHome, fullAway, { rho }),
    known,
  };
}

export function evaluateFixture(fixture, options = {}, strengths = null) {
  const settings = withDefaults(options);
  const model = modelFixture(fixture, strengths);
  const probabilities = marketProbabilities(model, model.full);

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
      fullExpectedGoals: model.full.expectedGoals,
      fullResult: model.full.result,
    },
    markets,
    signals: selectSignals(markets, settings),
  };
}

export const evaluateAllFixtures = (fixtures, options = {}, strengths = null) =>
  fixtures.map((fixture) => evaluateFixture(fixture, options, strengths));
