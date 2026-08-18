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
FORCE_NODE=0
PORT_FIXED=0
PORT="${PORT:-8100}"

while [ $# -gt 0 ]; do
  case "$1" in
    --service) INSTALL_SERVICE=1 ;;
    --provider) PROVIDER="${2:-api-tennis}"; shift ;;
    --install-node) FORCE_NODE=1 ;;
    --port) PORT="${2:-8100}"; PORT_FIXED=1; shift ;;
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

# Под root sudo не нужен, а на минимальных образах его часто и нет.
if [ "$(id -u)" = "0" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

# ---------------------------------------------------------------------

step 1 "Проверка окружения"

NODE_MAJOR=0
# Через && нельзя: при отсутствии node вся строка вернёт ненулевой код,
# и set -e молча оборвёт установку до первого понятного сообщения.
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi

say_node() { printf '    %s\n' "$1"; }

install_node() {
  if [ "$IS_TERMUX" = 1 ]; then
    pkg install -y nodejs-lts || return 1
    return 0
  fi
  command -v apt-get >/dev/null 2>&1 || return 1

  say_node "ставлю Node 22 из NodeSource (это займёт минуту)"
  # Под root SUDO пуст, и "$SUDO -E bash -" превратилось бы в попытку
  # выполнить команду "-E". Поэтому две отдельные ветки.
  if [ -n "$SUDO" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null 2>&1 || return 1
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || return 1
  fi
  $SUDO apt-get install -y nodejs >/dev/null 2>&1 || return 1
}

if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  ok "Node $(node -v)$([ "$IS_TERMUX" = 1 ] && echo ' (Termux)')"
else
  if [ "$NODE_MAJOR" = "0" ]; then
    warn "Node.js не установлен"
  else
    # В репозиториях Ubuntu лежит Node 18, а он снят с поддержки.
    warn "установлен Node $(node -v), нужен 20 или новее"
  fi

  DO_INSTALL="$FORCE_NODE"
  if [ "$DO_INSTALL" = 0 ]; then
    printf '    Поставить Node 22 автоматически? [Y/n]: '
    # Без stdin (запуск по конвейеру) read вернёт ошибку и уронит set -e.
    read -r answer || answer="y"
    printf '\n'
    case "${answer:-y}" in [Nn]*) DO_INSTALL=0 ;; *) DO_INSTALL=1 ;; esac
  fi

  if [ "$DO_INSTALL" = 1 ] && install_node; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 20 ] || die "после установки всё ещё Node $(node -v)"
    ok "Node $(node -v)"
  else
    die "нужен Node 20+. Поставить вручную:
      curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO:+$SUDO -E }bash -
      ${SUDO:+$SUDO }apt-get install -y nodejs"
  fi
fi

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

# Порт мог занять другой проект на этом же сервере. Молча упасть на этом
# в самом конце установки — худший вариант, поэтому подбираем заранее.
FREE_PORT="$(node scripts/find-port.js "$PORT" 2>/dev/null || echo "$PORT")"
if [ "$FREE_PORT" != "$PORT" ]; then
  if [ "$PORT_FIXED" = 1 ]; then
    die "порт $PORT занят, а он задан явно. Освободи его или укажи другой: --port $FREE_PORT"
  fi
  warn "порт $PORT занят, беру $FREE_PORT"
  PORT="$FREE_PORT"
fi

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

step 5 "Команда signals"

# Обёртка нужна не для красоты: половина неудачных запусков — это команды,
# выполненные не в том каталоге. Она подставляет каталог сама.
BINDIR="/usr/local/bin"
if [ -d "$BINDIR" ] && [ -w "$BINDIR" ] || [ -n "$SUDO" ]; then
  sed "s|__ROOT__|$ROOT|" bin/signals | $SUDO tee "$BINDIR/signals" >/dev/null \
    && $SUDO chmod +x "$BINDIR/signals" \
    && ok "команда signals доступна из любого каталога"
else
  warn "не удалось поставить команду signals в $BINDIR"
  warn "пользуйся полными путями: cd $ROOT && npm run launch"
fi

# ---------------------------------------------------------------------

step 6 "Проверка связи и запуск"

# shellcheck disable=SC2046
export $(grep -v '^#' .env | grep -v '^$' | xargs) 2>/dev/null || true

if [ "$INSTALL_SERVICE" = 1 ]; then
  [ "$IS_TERMUX" = 1 ] && die "systemd в Termux нет — запускай без --service"
  command -v systemctl >/dev/null 2>&1 || die "systemctl не найден"

  # Каталог должен существовать до старта службы: на него ссылается
  # ReadWritePaths, и systemd не поднимет юнит с несуществующим путём.
  mkdir -p data

  node scripts/launch.js --check || die "проверки не пройдены, служба не установлена"

  # Юнит запускается от www-data; под этим пользователем нужен доступ к каталогу.
  RUN_USER="$(id -un)"
  sed -e "s|/opt/signals|$ROOT|g" -e "s|^User=.*|User=$RUN_USER|" deploy/signals.service \
    | $SUDO tee /etc/systemd/system/signals.service >/dev/null
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now signals
  ok "служба signals запущена и будет подниматься после перезагрузки"

  echo
  echo "Логи:       journalctl -u signals -f"
  echo "Перезапуск: ${SUDO:+$SUDO }systemctl restart signals"
else
  exec node scripts/launch.js
fi
