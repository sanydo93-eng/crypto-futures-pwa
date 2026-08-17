import * as mock from './mock.js';
import { createProvider as createApiTennis } from './apiTennis.js';

export function createProvider(config) {
  switch (config.provider) {
    case 'mock':
      return mock;
    case 'api-tennis':
      return createApiTennis({ apiKey: config.apiKey, statsPath: config.statsPath });
    default:
      throw new Error(`Неизвестный провайдер: ${config.provider}. Доступны: mock, api-tennis`);
  }
}
