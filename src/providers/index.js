import * as tennisMock from './tennis/mock.js';
import { createProvider as createApiTennis } from './tennis/apiTennis.js';
import * as footballMock from './football/mock.js';

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
    default:
      throw new Error(
        `Неизвестный провайдер футбола: ${config.football.provider}. Доступен: mock`,
      );
  }
}
