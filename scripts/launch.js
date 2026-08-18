#!/usr/bin/env node
/**
 * Запуск с проверками.
 *
 * Обычный `npm start` поднимется даже при неверном ключе, несобранном
 * справочнике и разъехавшемся маппинге рынков — просто не покажет ни одного
 * сигнала, и понять почему будет неоткуда. Этот скрипт проходит те же шаги
 * по очереди и на каждом говорит, что не так.
 *
 *   npm run launch              # проверки и запуск
 *   npm run launch -- --check   # только проверки, без запуска
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, readFile } from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { createTennisProvider } from '../src/providers/index.js';
import { evaluateAll } from '../src/tennis/signals.js';

const checkOnly = process.argv.includes('--check');
const config = loadConfig();

let step = 0;
const stage = (title) => console.log(`\n[${++step}] ${title}`);
const ok = (text) => console.log(`    ✓ ${text}`);
const warn = (text) => console.log(`    ! ${text}`);

function fail(text, hints = []) {
  console.error(`    ✗ ${text}`);
  for (const hint of hints) console.error(`      ${hint}`);
  process.exit(1);
}

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`код ${code}`))));
    child.on('error', reject);
  });

const exists = (path) => access(path).then(() => true, () => false);

/** Свободен ли порт. Пробная привязка — единственная надёжная проверка. */
const portIsFree = (port, host) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });

/* ------------------------------------------------------------------ */

console.log('Проверка перед запуском\n' + '─'.repeat(40));

stage('Настройки');
if (config.tennis.provider === 'mock') {
  warn('PROVIDER=mock — теннис пойдёт на демо-данных.');
  warn('Для боевых котировок: PROVIDER=api-tennis и API_TENNIS_KEY в .env');
} else {
  ok(`провайдер тенниса: ${config.tennis.provider}`);
  if (!config.tennis.apiKey) {
    fail('API_TENNIS_KEY пуст', [
      'cp .env.example .env && chmod 600 .env',
      'затем впиши ключ в .env',
    ]);
  }
  // Ключ не печатаем даже частично — он утекает в логи и историю команд.
  ok(`ключ задан (${config.tennis.apiKey.length} символов)`);
}

/** Файл может существовать и при этом быть пустым — проверяем содержимое. */
async function countPlayers(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return Object.keys(data.players ?? {}).length;
  } catch {
    return 0;
  }
}

stage('Справочник игроков');
const knownPlayers = (await exists(config.tennis.statsPath))
  ? await countPlayers(config.tennis.statsPath)
  : -1;

if (knownPlayers > 0) {
  ok(`${config.tennis.statsPath}: игроков ${knownPlayers}`);
} else if (knownPlayers === 0) {
  warn(`${config.tennis.statsPath} пуст — пересобираю`);
  try {
    await run(process.execPath, ['scripts/build-stats.js', '--from', '2021', '--to', '2025']);
    ok('справочник пересобран');
  } catch (err) {
    warn(`пересборка не удалась: ${err.message}`);
    warn('приложение поднимется, но преимуществ не покажет');
  }
} else if (config.tennis.provider === 'mock') {
  warn('не собран, но для демо-данных он и не нужен');
} else {
  warn(`${config.tennis.statsPath} не найден — собираю`);
  warn('без него все игроки считаются средними и преимущества не будет');
  try {
    await run(process.execPath, ['scripts/build-stats.js', '--from', '2021', '--to', '2025']);
    ok('справочник собран');
  } catch (err) {
    // Не фатально: без справочника приложение работает, просто не находит
    // преимуществ. Ронять запуск из-за этого — значит скрыть от пользователя
    // проверку ключа, которая идёт следом и куда важнее.
    warn(`сборка не удалась: ${err.message}`);
    warn('нужен доступ к raw.githubusercontent.com; проверь сеть на сервере');
    warn('приложение поднимется, но преимуществ не покажет');
  }
}

stage('Поправка вероятностей');
if (await exists(config.tennis.calibrationPath)) {
  ok(`${config.tennis.calibrationPath} — будет применена`);
} else {
  warn('не подобрана, модель работает как есть (это нормальный режим)');
  warn('подобрать: npm run backtest -- --save-calibration '
    + config.tennis.calibrationPath);
}

stage('Связь с провайдером');
let matches = [];
try {
  const provider = createTennisProvider(config);
  matches = await provider.fetchMatches();
  ok(`ответ получен, матчей с нужными рынками: ${matches.length}`);
} catch (err) {
  fail(`провайдер недоступен: ${err.message}`, [
    /HTTP 40[13]/.test(err.message)
      ? 'ключ отклонён или метод не входит в тариф — проверь в кабинете'
      : 'проверь сеть и firewall на сервере',
    'подробности: npm run probe',
  ]);
}

if (matches.length === 0 && config.tennis.provider !== 'mock') {
  // Ноль матчей — не повод не запускаться: сегодня их может не быть, а завтра
  // появятся. Раньше это роняло установку и мешало поставить службу.
  warn('матчей с нужными рынками сейчас нет');
  warn('это нормально, если на дату нет подходящих матчей — приложение подхватит их само');
  warn('но если пусто и завтра, значит названия рынков разъехались:');
  warn('  npm run probe   — покажет сырой ответ и что из него разобрано');
}

stage('Пробный разбор');
const evaluated = evaluateAll(matches, config.scoring);
const signals = evaluated.reduce((sum, m) => sum + m.signals.length, 0);
const unknown = matches.filter((m) => m.players?.a?.known === false).length;

ok(`разобрано матчей: ${evaluated.length}, сигналов: ${signals}`);
if (unknown > 0) {
  warn(`игроков вне справочника в ${unknown} матчах — там преимущества не будет`);
}
if (signals === 0) {
  warn('сигналов нет. Это нормально: рынок чаще прав, чем нет.');
  warn(`порог сейчас ${(config.scoring.minEdge * 100).toFixed(0)}% (MIN_EDGE)`);
}

stage('Порт');
if (await portIsFree(config.port, config.host)) {
  ok(`${config.host}:${config.port} свободен`);
} else if (checkOnly) {
  warn(`${config.port} занят — вероятно, приложение уже работает`);
} else {
  // Ищем следующий свободный, чтобы подсказка была конкретной, а не
  // «выбери другой порт» без указания какой.
  let suggestion = null;
  for (let port = config.port + 1; port < config.port + 20; port++) {
    if (await portIsFree(port, config.host)) {
      suggestion = port;
      break;
    }
  }

  fail(`порт ${config.port} занят`, [
    'если приложение уже запущено службой: systemctl restart signals',
    suggestion
      ? `свободен ${suggestion} — запуск: PORT=${suggestion} npm run launch`
      : 'свободного порта рядом не нашлось',
    suggestion ? `или навсегда: sed -i "s/^PORT=.*/PORT=${suggestion}/" .env` : '',
  ].filter(Boolean));
}

console.log('\n' + '─'.repeat(40));

if (checkOnly) {
  console.log('Проверки пройдены. Запуск: npm start');
  process.exit(0);
}

console.log(`Запускаю сервер на ${config.host}:${config.port}\n`);
try {
  await run(process.execPath, ['server.js']);
} catch (err) {
  // Сервер уже напечатал свою ошибку; стек запускающего скрипта здесь лишний.
  console.error(`\nСервер остановился (${err.message}).`);
  process.exit(1);
}
