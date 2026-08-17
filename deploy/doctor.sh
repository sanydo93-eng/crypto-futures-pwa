#!/usr/bin/env bash
# Сбор диагностики одной командой.
#
#   bash deploy/doctor.sh
#
# Печатает всё, что нужно, чтобы понять, на каком шаге встало.
# Ключи и пароли не печатаются — только факт их наличия и длина.
set -uo pipefail

cd "$(dirname "$0")/.." 2>/dev/null || true
ROOT="$(pwd)"

hr()  { printf '\n=== %s\n' "$1"; }
say() { printf '  %s\n' "$1"; }

PORT="8100"
[ -f .env ] && PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-8100}"

hr "СИСТЕМА"
say "каталог:  $ROOT"
say "польз.:   $(id -un) (uid $(id -u))"
say "система:  $(uname -sr)"
if command -v node >/dev/null 2>&1; then
  say "node:     $(node -v)"
else
  say "node:     НЕ УСТАНОВЛЕН"
fi

hr "РЕПОЗИТОРИЙ"
if [ -d .git ]; then
  say "ветка:  $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  say "коммит: $(git rev-parse --short HEAD 2>/dev/null)"
  say "файлы:  server.js $([ -f server.js ] && echo есть || echo НЕТ), \
scripts/launch.js $([ -f scripts/launch.js ] && echo есть || echo НЕТ)"
else
  say "это не git-каталог — репозиторий не склонирован сюда"
fi

hr "НАСТРОЙКИ"
if [ -f .env ]; then
  say "права .env: $(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null)"
  for key in PROVIDER FOOTBALL_PROVIDER HOST PORT MIN_EDGE; do
    value="$(grep -E "^${key}=" .env | cut -d= -f2-)"
    say "$key = ${value:-<не задано>}"
  done
  # Длина вместо значения: сам ключ в вывод попасть не должен.
  api_key="$(grep -E '^API_TENNIS_KEY=' .env | cut -d= -f2-)"
  say "API_TENNIS_KEY: ${api_key:+задан, длина ${#api_key}}${api_key:-НЕ ЗАДАН}"
else
  say ".env отсутствует — установщик не доходил до шага настроек"
fi

hr "ДАННЫЕ"
if [ -f data/player-stats.json ]; then
  players="$(node -e 'const d=require("./data/player-stats.json");console.log(Object.keys(d.players??{}).length)' 2>/dev/null || echo '?')"
  say "справочник игроков: игроков $players, размер $(du -h data/player-stats.json | cut -f1)"
else
  say "справочник игроков: НЕТ (преимуществ не будет)"
fi
[ -f data/tennis-calibration.json ] && say "поправка: есть" || say "поправка: нет (нормально)"

hr "СЛУЖБА"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^signals.service'; then
    say "состояние: $(systemctl is-active signals 2>/dev/null) / $(systemctl is-enabled signals 2>/dev/null)"
    echo "  --- последние строки журнала ---"
    journalctl -u signals -n 25 --no-pager 2>/dev/null | sed 's/^/  /'
  else
    say "юнит signals не установлен (запуск без --service либо установка не дошла)"
  fi
else
  say "systemd нет (Termux или контейнер) — служба неприменима"
fi

hr "ПОРТ $PORT"
if command -v ss >/dev/null 2>&1; then
  listening="$(ss -tlnp 2>/dev/null | grep ":${PORT}\b")"
elif command -v netstat >/dev/null 2>&1; then
  listening="$(netstat -tlnp 2>/dev/null | grep ":${PORT}\b")"
else
  listening=""
fi

if [ -n "$listening" ]; then
  say "слушает: $listening"
  case "$listening" in
    *127.0.0.1:*) say "ВНИМАНИЕ: только localhost — снаружи не откроется, нужен HOST=0.0.0.0" ;;
  esac
else
  say "никто не слушает — приложение не запущено"
fi

hr "ЛОКАЛЬНЫЙ ОТВЕТ"
if command -v curl >/dev/null 2>&1; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)"
  say "GET /api/health -> ${code:-нет ответа}"
  if [ "$code" = "200" ]; then
    curl -sS --max-time 10 "http://127.0.0.1:${PORT}/api/signals?sport=tennis" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);console.log(`  провайдер: ${p.provider}, матчей: ${p.matches.length}, сигналов: ${p.signalCount}`);}catch(e){console.log("  ответ не разобран");}})' 2>/dev/null
  fi
else
  say "curl не установлен"
fi

hr "ВНЕШНИЙ ДОСТУП"
ext="$(curl -sS --max-time 5 https://api.ipify.org 2>/dev/null)"
say "внешний IP: ${ext:-не определён}"
if [ -n "$ext" ]; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "http://${ext}:${PORT}/api/health" 2>/dev/null)"
  say "снаружи GET /api/health -> ${code:-НЕТ ОТВЕТА (режет firewall)}"
fi
command -v ufw >/dev/null 2>&1 && say "ufw: $(ufw status 2>/dev/null | head -1)"

hr "СЕТЬ ДО ПРОВАЙДЕРОВ"
for host in api.api-tennis.com raw.githubusercontent.com; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://${host}" 2>/dev/null)"
  say "$host -> ${code:-НЕДОСТУПЕН}"
done

printf '\n=== Пришли весь вывод целиком.\n'
