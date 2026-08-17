/**
 * Сопоставление названий команд между источниками.
 *
 * Это главная практическая проблема связки «котировки + статистика»: букмекер
 * пишет «Man Utd», архив результатов — «Man United», а модель молча не находит
 * команду и подставляет средний уровень лиги. Сигналов при этом не будет вовсе
 * либо, что хуже, они появятся не там.
 */

/** Слова, которые ничего не различают и только мешают сравнению. */
const NOISE = /\b(fc|afc|cf|sc|ac|as|ss|us|ud|cd|sv|vfl|vfb|bsc|fk|if|ff|club|calcio)\b/g;

export function normalizeTeamName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    // Апостроф в названиях — всегда пропуск букв («Nott'm»), поэтому убираем
    // его без пробела, иначе слово разваливается надвое.
    .replace(/['`’]/g, '')
    .replace(/[.\-_/]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Сокращения, которые нормализацией не свести: разные слова, а не разное
 * написание. Ключ и значение приводятся к нормальной форме при сравнении,
 * поэтому регистр и точки здесь не важны.
 *
 * Список заведомо неполный — он покрывает частые случаи английских лиг.
 * Недостающие пары показывает `npm run probe`, дописывать сюда.
 */
export const ALIASES = {
  'man utd': 'man united',
  'man city': 'manchester city',
  'manchester utd': 'man united',
  'manchester united': 'man united',
  'nottm forest': 'nottingham forest',
  "nott'm forest": 'nottingham forest',
  'sheff utd': 'sheffield united',
  'sheff wed': 'sheffield weds',
  'wolverhampton': 'wolves',
  'wolverhampton wanderers': 'wolves',
  'tottenham hotspur': 'tottenham',
  'spurs': 'tottenham',
  'west brom': 'west bromwich albion',
  'brighton and hove albion': 'brighton',
  'newcastle united': 'newcastle',
  'leeds united': 'leeds',
  'leicester city': 'leicester',
  'norwich city': 'norwich',
  'hull city': 'hull',
  'stoke city': 'stoke',
  'swansea city': 'swansea',
  'cardiff city': 'cardiff',
  'birmingham city': 'birmingham',
  'coventry city': 'coventry',
  'ipswich town': 'ipswich',
  'luton town': 'luton',
  'paris saint germain': 'paris sg',
  'psg': 'paris sg',
  'bayern munich': 'bayern munich',
  'borussia dortmund': 'dortmund',
  'borussia monchengladbach': 'mgladbach',
  'bayer leverkusen': 'leverkusen',
  'eintracht frankfurt': 'ein frankfurt',
  'atletico madrid': 'ath madrid',
  'athletic bilbao': 'ath bilbao',
  'real sociedad': 'sociedad',
  'real betis': 'betis',
  'celta vigo': 'celta',
  'internazionale': 'inter',
  'inter milan': 'inter',
  'ac milan': 'milan',
  'as roma': 'roma',
  'hellas verona': 'verona',
};

const NORMALIZED_ALIASES = new Map(
  Object.entries(ALIASES).map(([from, to]) => [normalizeTeamName(from), normalizeTeamName(to)]),
);

/** Каноническая форма: нормализация плюс разворачивание сокращения. */
export function canonicalTeamName(name) {
  const normalized = normalizeTeamName(name);
  return NORMALIZED_ALIASES.get(normalized) ?? normalized;
}

/**
 * Индекс для поиска по любому написанию.
 * @param {Iterable<string>} names названия в том виде, в каком они в справочнике
 */
export function buildNameIndex(names) {
  const index = new Map();
  for (const name of names) {
    const canonical = canonicalTeamName(name);
    // Первое написание побеждает: справочник — источник истины.
    if (!index.has(canonical)) index.set(canonical, name);
  }
  return index;
}
