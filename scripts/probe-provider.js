#!/usr/bin/env node
/**
 * Диагностика провайдера коэффициентов.
 *
 * Показывает сырой ответ API и то, во что он превращается после разбора.
 * Нужен, потому что схему api-tennis я проверить на живом ключе не мог:
 * если названия рынков или полей разъехались, это будет видно здесь сразу.
 *
 *   API_TENNIS_KEY=... node scripts/probe-provider.js
 */
import { loadConfig } from '../src/config.js';
import { createTennisProvider } from '../src/providers/index.js';
import { evaluateMatch } from '../src/tennis/signals.js';

const config = loadConfig();
if (config.tennis.provider === 'mock') {
  console.log('PROVIDER=mock — проверять нечего. Запусти с PROVIDER=api-tennis и ключом.\n');
}

const provider = createTennisProvider(config);
const matches = await provider.fetchMatches();

console.log(`Провайдер: ${provider.name}`);
console.log(`Матчей с коэффициентами: ${matches.length}\n`);

if (matches.length === 0) {
  console.log('Пусто. Обычные причины:');
  console.log('  - на выбранную дату нет матчей с нужными рынками;');
  console.log('  - в тарифе нет доступа к методу get_odds;');
  console.log('  - названия рынков у провайдера отличаются от MARKET_ALIASES');
  console.log('    в src/providers/apiTennis.js.');
  process.exit(0);
}

for (const match of matches.slice(0, 3)) {
  console.log('─'.repeat(60));
  console.log(`${match.players.a.name} — ${match.players.b.name}`);
  console.log(`  ${match.tournament} | ${match.surface} | ${match.tour} | bo${match.bestOf}`);

  for (const [side, player] of Object.entries(match.players)) {
    const status = player.known
      ? `${player.matches} матчей в статистике`
      : 'НЕТ В СТАТИСТИКЕ — используется средний уровень тура';
    console.log(`  ${side}: подача ${(player.spw * 100).toFixed(1)}%, приём ${(player.rpw * 100).toFixed(1)}% (${status})`);
  }

  console.log('  рынки:', Object.keys(match.markets).join(', ') || 'нет');

  const result = evaluateMatch(match, config.scoring);
  console.log(`  модель: победа ${(result.model.aWins * 100).toFixed(1)}%`);
  console.log(`  сигналов: ${result.signals.length}`);
  for (const signal of result.signals) {
    console.log(
      `    ${signal.market} ${signal.outcome}: модель ${(signal.modelProb * 100).toFixed(1)}%, ` +
      `кэф ${signal.marketOdds}, преимущество ${(signal.edge * 100).toFixed(1)}%`,
    );
  }
}

console.log('─'.repeat(60));
console.log('\nЕсли игроки массово помечены как отсутствующие в статистике —');
console.log('собери справочник: node scripts/build-stats.js --from 2021 --to 2025');
