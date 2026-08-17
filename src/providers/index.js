import * as tennisMock from './tennis/mock.js';
import { createProvider as createApiTennis } from './tennis/apiTennis.js';
import * as footballMock from './football/mock.js';
import { createProvider as createBetsapi } from './football/betsapi.js';

export function createTennisProvider(config) {
  switch (config.tennis.provider) {
    case 'mock':
      return tennisMock;
    case 'api-tennis':
      return createApiTennis({
        apiKey: config.tennis.apiKey,
        statsPath: config.tennis.statsPath,
      });
    default:
      throw new Error(
        `Неизвестный провайдер тенниса: ${config.tennis.provider}. Доступны: mock, api-tennis`,
      );
  }
}

export function createFootballProvider(config) {
  switch (config.football.provider) {
    case 'mock':
      return footballMock;
    case 'betsapi':
      return createBetsapi({
        token: config.football.betsapiToken,
        statsPath: config.football.statsPath,
        leagues: config.football.leagues,
        maxEvents: config.football.maxEvents,
      });
    default:
      throw new Error(
        `Неизвестный провайдер футбола: ${config.football.provider}. Доступны: mock, betsapi`,
      );
  }
}
