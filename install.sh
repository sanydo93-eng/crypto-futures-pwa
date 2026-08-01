#!/usr/bin/env bash
# One-command install on a fresh server:
#
#   curl -fsSL https://raw.githubusercontent.com/sanydo93-eng/crypto-futures-pwa/claude/server-tg-signals-setup-mxo0y9/install.sh | bash
#
# Asks for the bot token and channel, writes .env, builds and starts.
set -euo pipefail

REPO_URL="https://github.com/sanydo93-eng/crypto-futures-pwa.git"
BRANCH="claude/server-tg-signals-setup-mxo0y9"
DIR="${INSTALL_DIR:-/opt/crypto-futures-pwa}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31mОшибка: %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запусти от root или через sudo"

say "Проверяю зависимости"
command -v git >/dev/null 2>&1 || {
  echo "Ставлю git..."
  (apt-get update -qq && apt-get install -y -qq git) >/dev/null 2>&1 \
    || yum install -y git >/dev/null 2>&1 \
    || die "не смог поставить git, поставь вручную"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден, ставлю с get.docker.com..."
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "не смог поставить Docker"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "нет docker compose. Поставь пакет docker-compose-plugin"
fi

systemctl start docker >/dev/null 2>&1 || true

say "Забираю код в $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH" --quiet
  git -C "$DIR" checkout "$BRANCH" --quiet
  git -C "$DIR" reset --hard "origin/$BRANCH" --quiet
else
  git clone --branch "$BRANCH" --quiet "$REPO_URL" "$DIR"
fi
cd "$DIR"

if [ -f .env ]; then
  say "Нашёл существующий .env — оставляю его как есть"
else
  say "Настройка Telegram"
  echo "Токен бота берётся у @BotFather. Бот должен быть админом канала"
  echo "с правом «Публикация сообщений». Ввод токена не отображается."
  echo

  printf 'Токен бота: '
  read -rs TOKEN < /dev/tty
  echo
  [ -n "$TOKEN" ] || die "токен пустой"

  printf 'Канал (@имя_канала или -100...): '
  read -r CHAT < /dev/tty
  [ -n "$CHAT" ] || die "канал не указан"

  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

  cp .env.example .env
  # Replacements go through a temp file so the token never lands in ps output.
  python3 - "$TOKEN" "$CHAT" "http://${IP}:8080" <<'PY'
import sys
token, chat, app_url = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(".env", encoding="utf-8").read().splitlines()
out = []
for line in lines:
    if line.startswith("TELEGRAM_BOT_TOKEN="):
        line = f"TELEGRAM_BOT_TOKEN={token}"
    elif line.startswith("TELEGRAM_CHAT_ID="):
        line = f"TELEGRAM_CHAT_ID={chat}"
    elif line.startswith("APP_URL="):
        line = f"APP_URL={app_url}"
    out.append(line)
open(".env", "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
  chmod 600 .env
  unset TOKEN
  echo "Записал .env (права 600)"
fi

say "Собираю образ (первый раз это пара минут)"
$COMPOSE build

say "Запускаю"
$COMPOSE up -d
sleep 5
$COMPOSE ps

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

Готово.

  Приложение:  http://${IP}:8080
  Логи:        cd $DIR && $COMPOSE logs -f
  Обновиться:  cd $DIR && git pull && ./deploy.sh
  Остановить:  cd $DIR && $COMPOSE down

Если в канал ничего не приходит — первым делом посмотри логи: бот
проверяет токен, канал и символы при старте и пишет причину открытым текстом.
EOF
