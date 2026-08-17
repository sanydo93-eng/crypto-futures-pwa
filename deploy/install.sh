#!/usr/bin/env bash
# Установка приложения одной командой.
#
#   bash deploy/install.sh                  # спросит ключ, соберёт данные, запустит
#   bash deploy/install.sh --service        # плюс автозапуск через systemd
#   bash deploy/install.sh --provider mock  # без ключа, на демо-данных
#
# Работает и на сервере (Debian/Ubuntu), и на телефоне в Termux.
set -euo pipefail

PROVIDER="api-tennis"
INSTALL_SERVICE=0
PORT="${PORT:-8100}"

while [ $# -gt 0 ]; do
  case "$1" in
    --service) INSTALL_SERVICE=1 ;;
    --provider) PROVIDER="${2:-api-tennis}"; shift ;;
    --port) PORT="${2:-8100}"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Неизвестный аргумент: $1"; exit 1 ;;
  esac
  shift
done

step()  { printf '\n\033[1m[%s]\033[0m %s\n' "$1" "$2"; }
ok()    { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '    \033[31m✗\033[0m %s\n' "$1"; exit 1; }

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

IS_TERMUX=0
[ -n "${PREFIX:-}" ] && case "$PREFIX" in *com.termux*) IS_TERMUX=1 ;; esac

# ---------------------------------------------------------------------

step 1 "Проверка окружения"

if ! command -v node >/dev/null 2>&1; then
  if [ "$IS_TERMUX" = 1 ]; then
    die "Node.js не установлен. Поставь: pkg install -y nodejs-lts"
  fi
  die "Node.js не установлен. Поставь Node 20+:
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt install -y nodejs"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "нужен Node 20+, установлен $(node -v)"
ok "Node $(node -v)$([ "$IS_TERMUX" = 1 ] && echo ' (Termux)')"

# Зависимостей у проекта нет — сверяем это, а не устанавливаем.
if [ -d node_modules ]; then
  ok "node_modules есть (проекту не требуется)"
else
  ok "внешних зависимостей не требуется"
fi

# ---------------------------------------------------------------------

step 2 "Настройки"

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  ok "создан .env (права 600)"
else
  ok ".env уже есть — не трогаю"
fi

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    # Значение может содержать /, поэтому разделитель у sed — вертикальная черта.
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env PROVIDER "$PROVIDER"
set_env PORT "$PORT"
set_env HOST "0.0.0.0"
ok "провайдер: $PROVIDER, порт: $PORT, слушает 0.0.0.0"

if [ "$PROVIDER" = "api-tennis" ]; then
  CURRENT_KEY="$(grep '^API_TENNIS_KEY=' .env | cut -d= -f2- || true)"
  if [ -n "$CURRENT_KEY" ]; then
    ok "ключ уже записан в .env"
  else
    # read -s: ключ не появится ни на экране, ни в истории команд.
    printf '    Вставь ключ api-tennis и нажми Enter: '
    read -rs API_KEY
    printf '\n'
    [ -n "$API_KEY" ] || die "ключ пустой"
    set_env API_TENNIS_KEY "$API_KEY"
    unset API_KEY
    ok "ключ записан в .env"
  fi
fi

# ---------------------------------------------------------------------

step 3 "Тесты"
if node --test "test/**/*.test.js" >/tmp/signals-tests.log 2>&1; then
  ok "$(grep -c '^ok ' /tmp/signals-tests.log 2>/dev/null || echo 'все') проверок пройдено"
else
  warn "тесты не прошли, подробности в /tmp/signals-tests.log"
  warn "установка продолжается, но что-то в окружении не так"
fi

# ---------------------------------------------------------------------

step 4 "Справочник игроков"

if [ -f data/player-stats.json ] && [ -s data/player-stats.json ]; then
  ok "уже собран"
else
  warn "собираю из открытого архива (несколько минут)"
  if node scripts/build-stats.js --from 2021 --to 2025; then
    ok "справочник собран"
  else
    warn "не собрался — приложение поднимется, но преимуществ не покажет"
    warn "нужен доступ к raw.githubusercontent.com"
  fi
fi

# ---------------------------------------------------------------------

step 5 "Проверка связи и запуск"

# shellcheck disable=SC2046
export $(grep -v '^#' .env | grep -v '^$' | xargs) 2>/dev/null || true

if [ "$INSTALL_SERVICE" = 1 ]; then
  [ "$IS_TERMUX" = 1 ] && die "systemd в Termux нет — запускай без --service"
  command -v systemctl >/dev/null 2>&1 || die "systemctl не найден"

  node scripts/launch.js --check || die "проверки не пройдены, служба не установлена"

  sed "s|/opt/signals|$ROOT|g" deploy/signals.service | sudo tee /etc/systemd/system/signals.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now signals
  ok "служба signals запущена и будет подниматься после перезагрузки"

  echo
  echo "Логи:      journalctl -u signals -f"
  echo "Перезапуск: sudo systemctl restart signals"
else
  exec node scripts/launch.js
fi
