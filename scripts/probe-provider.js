#!/usr/bin/env node
/**
 * Диагностика провайдеров коэффициентов.
 *
 * Схемы api-tennis и BetsAPI написаны по документации и на живых ключах не
 * проверялись. Разъехавшийся маппинг не падает с ошибкой — он молча даёт
 * неверные сигналы, поэтому проверять нужно глазами.
 *
 *   npm run probe                                   # теннис
 *   npm run probe -- --sport football               # футбол
 *   npm run probe -- --sport football --raw         # плюс сырой ответ API
 */
import { loadConfig } from '../src/config.js';
import { createTennisProvider, createFootballProvider } from '../src/providers/index.js';
import { evaluateMatch } from '../src/tennis/signals.js';
import { evaluateFixture } from '../src/football/signals.js';
import { extractFirstHalfMarkets } from '../src/providers/football/betsapi.js';
import { TeamStrengths } from '../src/football/strength.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const sport = option('sport', 'tennis');
const config = loadConfig();
const line = () => console.log('─'.repeat(64));
const percent = (value) => `${(value * 100).toFixed(1)}%`;

function printSignals(result) {
  console.log(`  сигналов: ${result.signals.length}`);
  for (const signal of result.signals) {
    console.log(
      `    ${signal.market} ${signal.outcome}: модель ${percent(signal.modelProb)}, `
      + `кэф ${signal.marketOdds}, преимущество ${percent(signal.edge)}`,
    );
  }
}

/* ------------------------------------------------------------------ */

async function probeTennis() {
  if (config.tennis.provider === 'mock') {
    console.log('PROVIDER=mock — проверять нечего. Нужен PROVIDER=api-tennis и ключ.\n');
  }

  const provider = createTennisProvider(config);
  const matches = await provider.fetchMatches();

  console.log(`Провайдер: ${provider.name}`);
  console.log(`Матчей с коэффициентами: ${matches.length}\n`);

  if (matches.length === 0) {
    console.log('Пусто. Обычные причины:');
    console.log('  - на дату нет матчей с нужными рынками;');
    console.log('  - в тарифе нет доступа к методу get_odds;');
    console.log('  - названия рынков отличаются от MARKET_ALIASES');
    console.log('    в src/providers/tennis/apiTennis.js.');
    return;
  }

  for (const match of matches.slice(0, 3)) {
    line();
    console.log(`${match.players.a.name} — ${match.players.b.name}`);
    console.log(`  ${match.tournament} | ${match.surface} | ${match.tour} | bo${match.bestOf}`);

    for (const [side, player] of Object.entries(match.players)) {
      const status = player.known
        ? `${player.matches} матчей в статистике`
        : 'НЕТ В СТАТИСТИКЕ — берётся средний уровень тура';
      console.log(
        `  ${side}: подача ${percent(player.spw)}, приём ${percent(player.rpw)} (${status})`,
      );
    }

    console.log('  рынки:', Object.keys(match.markets).join(', ') || 'нет');
    const result = evaluateMatch(match, config.scoring);
    console.log(`  модель: победа ${percent(result.model.aWins)}`);
    printSignals(result);
  }

  line();
  console.log('\nЕсли игроки массово не найдены в статистике —');
  console.log('собери справочник: node scripts/build-stats.js --from 2021 --to 2025');
}

/* ------------------------------------------------------------------ */

async function probeFootball() {
  if (config.football.provider === 'mock') {
    console.log('FOOTBALL_PROVIDER=mock — проверять нечего.');
    console.log('Нужен FOOTBALL_PROVIDER=betsapi и BETSAPI_TOKEN.\n');
  }

  const provider = createFootballProvider(config);
  console.log(`Провайдер: ${provider.name}`);
  if (config.football.leagues.length) {
    console.log(`Фильтр лиг: ${config.football.leagues.join(', ')}`);
  } else {
    console.log('Фильтр лиг не задан — придут все лиги мира. Задай BETSAPI_LEAGUES.');
  }

  // Сырой ответ: единственный способ понять, как на самом деле называются рынки.
  if (flag('raw') && provider.fetchRaw) {
    const raw = await provider.fetchRaw();
    line();
    console.log('СЫРОЙ ОТВЕТ /v1/bet365/upcoming (первое событие):');
    console.dir(raw.upcoming?.[0] ?? null, { depth: 4 });

    console.log('\nСЫРОЙ ОТВЕТ /v3/bet365/prematch (первое событие):');
    console.dir(raw.prematch?.[0] ?? null, { depth: 6 });

    if (raw.prematch?.[0]) {
      const { found, available } = extractFirstHalfMarkets(raw.prematch[0]);
      console.log('\nРынки, найденные разбором:', found.join(', ') || 'НИ ОДНОГО');
      console.log('Все рынки в ответе:');
      for (const marketName of available) console.log(`  - ${marketName}`);
      console.log('\nЕсли нужных рынков нет среди найденных, а в ответе они есть —');
      console.log('поправь MARKET_MATCHERS в src/providers/football/betsapi.js.');
    }
    line();
  }

  const fixtures = await provider.fetchFixtures();
  console.log(`\nМатчей с рынками первого тайма: ${fixtures.length}\n`);

  if (fixtures.length === 0) {
    console.log('Пусто. Обычные причины:');
    console.log('  - фильтр лиг отсекает всё (BETSAPI_LEAGUES);');
    console.log('  - в тарифе нет доступа к /v3/bet365/prematch;');
    console.log('  - названия рынков не совпали — запусти с --raw и сверь.');
    return;
  }

  const strengths = provider.loadStrengths
    ? await provider.loadStrengths()
    : await TeamStrengths.load(config.football.statsPath);

  if (!strengths) {
    console.log('Справочник команд не собран — модель будет считать всех средними.');
    console.log('Собрать: node scripts/build-football-stats.js --league E0\n');
  }

  let unresolved = 0;
  for (const fixture of fixtures.slice(0, 5)) {
    line();
    console.log(`${fixture.home} — ${fixture.away}`);
    console.log(`  ${fixture.competition} | ${fixture.startsAt ?? 'время не указано'}`);

    for (const [side, team] of [['дома   ', fixture.home], ['в гостях', fixture.away]]) {
      const resolved = strengths?.resolve(team) ?? null;
      if (!resolved) unresolved += 1;
      console.log(`  ${side}: ${team} -> ${resolved ?? 'НЕ НАЙДЕНА В СПРАВОЧНИКЕ'}`);
    }

    console.log('  рынки:', Object.keys(fixture.markets).join(', ') || 'нет');

    const result = evaluateFixture(fixture, config.scoring, strengths);
    console.log(
      `  модель: гол в 1-м тайме ${percent(result.model.goalChance)}, `
      + `xG ${result.model.lambdaHome.toFixed(2)} : ${result.model.lambdaAway.toFixed(2)}`,
    );
    printSignals(result);
  }

  line();
  if (unresolved > 0) {
    console.log(`\nНе сопоставлено названий команд: ${unresolved}.`);
    console.log('Такие матчи считаются по среднему уровню лиги, преимущества на них не будет.');
    console.log('Допиши недостающие пары в ALIASES в src/football/names.js.');
  } else {
    console.log('\nВсе названия команд сопоставлены со справочником.');
  }
}

/* ------------------------------------------------------------------ */

const probes = { tennis: probeTennis, football: probeFootball };
const probe = probes[sport];

if (!probe) {
  console.error(`Неизвестный вид спорта: ${sport}. Доступны: tennis, football`);
  process.exit(1);
}

try {
  await probe();
} catch (err) {
  // Диагностический скрипт не должен пугать стеком: почти все отказы здесь —
  // это отсутствующий токен, закрытый тариф или сеть.
  console.error(`\nОшибка: ${err.message}\n`);

  if (/не задан/.test(err.message)) {
    console.error('Пропиши токен в .env и повтори:  cp .env.example .env && chmod 600 .env');
  } else if (/HTTP 40[13]/.test(err.message)) {
    console.error('Токен отклонён или метод не входит в тариф — проверь в кабинете провайдера.');
  } else if (/HTTP 404/.test(err.message)) {
    console.error('У BetsAPI 404 означает и «нет данных на дату», и «метод не входит в тариф».');
  } else if (/fetch failed|timeout|ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
    console.error('Сеть до провайдера недоступна — проверь firewall и DNS на сервере.');
  }
  process.exit(1);
}
