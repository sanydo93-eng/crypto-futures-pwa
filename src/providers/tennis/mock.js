/**
 * Демо-провайдер: фиксированный набор матчей без обращения к сети.
 *
 * Нужен, чтобы приложение поднималось и было проверяемо без ключей API.
 * Игроки вымышленные, коэффициенты выставлены руками — это витрина механики,
 * а не реальные котировки.
 */

const MATCHES = [
  {
    id: 'demo-1',
    tournament: 'Demo Open (демо-данные)',
    surface: 'hard',
    tour: 'atp',
    bestOf: 3,
    startsAt: null,
    aServesFirst: true,
    players: {
      a: { name: 'Смирнов А.', spw: 0.685, rpw: 0.395 },
      b: { name: 'Ковалёв Д.', spw: 0.63, rpw: 0.355 },
    },
    // Цены выставлены как у настоящего букмекера: примерно 15% маржи,
    // кроме двух исходов в первом сете, намеренно завышенных — на них
    // и должны сработать сигналы.
    markets: {
      correctScore: { '2-0': 1.42, '2-1': 3.25, '1-2': 11.5, '0-2': 18.0 },
      firstSetScore: {
        '6-0': 53, '6-1': 7.6, '6-2': 9.2, '6-3': 2.86, '6-4': 13.5, '7-5': 18.0, '7-6': 7.45,
        '0-6': 400, '1-6': 250, '2-6': 45, '3-6': 64, '4-6': 8.7, '5-7': 38, '6-7': 14.1,
      },
    },
  },
  {
    id: 'demo-2',
    tournament: 'Demo Clay Cup (демо-данные)',
    surface: 'clay',
    tour: 'wta',
    bestOf: 3,
    startsAt: null,
    aServesFirst: false,
    players: {
      a: { name: 'Тарасова Е.', spw: 0.575, rpw: 0.465 },
      b: { name: 'Литвинова М.', spw: 0.545, rpw: 0.44 },
    },
    markets: {
      // Завышен исход 1-2.
      correctScore: { '2-0': 1.8, '2-1': 2.87, '1-2': 8.6, '0-2': 8.65 },
    },
  },
  {
    id: 'demo-3',
    tournament: 'Demo Slam (демо-данные)',
    surface: 'grass',
    tour: 'atp',
    bestOf: 5,
    startsAt: null,
    aServesFirst: true,
    players: {
      a: { name: 'Белов И.', spw: 0.72, rpw: 0.34 },
      b: { name: 'Гордеев П.', spw: 0.655, rpw: 0.37 },
    },
    markets: {
      // Завышен исход 3-2.
      correctScore: {
        '3-0': 3.72, '3-1': 3.19, '3-2': 5.6,
        '2-3': 6.45, '1-3': 7.9, '0-3': 14.5,
      },
    },
  },
];

export const name = 'mock';

export async function fetchMatches() {
  // Копия, чтобы вызывающий код не мутировал константу.
  return structuredClone(MATCHES);
}
