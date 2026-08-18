#!/usr/bin/env bash
# Общие функции для скриптов развёртывания.
# Подключается через:  . "$(dirname "$0")/lib.sh"

# Под root sudo не нужен, а на минимальных образах его часто и нет.
detect_sudo() {
  if [ "$(id -u)" = "0" ]; then printf ''
  elif command -v sudo >/dev/null 2>&1; then printf 'sudo'
  else printf ''
  fi
}

# Проверить порт нечем — не значит, что он свободен. Именно так тихо врут
# однострочники вида `ss ... | grep порт`: без ss grep получает пустоту, и
# порт объявляется свободным. Поэтому три источника и явное «неизвестно».
#
# Печатает адрес, на котором слушает порт, либо ничего.
# Код возврата: 0 — слушает, 1 — не слушает, 2 — проверить нечем.
listen_addr() {
  local port="$1" found=""

  if command -v ss >/dev/null 2>&1; then
    found="$(ss -tln 2>/dev/null | awk -v p=":${port}\$" '$4 ~ p {print $4; exit}')"
  elif command -v netstat >/dev/null 2>&1; then
    found="$(netstat -tln 2>/dev/null | awk -v p=":${port}\$" '$4 ~ p {print $4; exit}')"
  elif [ -r /proc/net/tcp ]; then
    # Разбор /proc/net/tcp: состояние 0A — LISTEN, адрес и порт записаны
    # шестнадцатерично. Декодируем в bash, а не в awk: strtonum есть только
    # в gawk, а по умолчанию в Debian стоит mawk, и на нём это молча ломается.
    local hex raw
    hex="$(printf '%04X' "$port")"
    raw="$(awk -v h="$hex" '$4=="0A"{split($2,a,":"); if(a[2]==h){print a[1]; exit}}' \
      /proc/net/tcp 2>/dev/null)"

    if [ -n "$raw" ] && [ ${#raw} -eq 8 ]; then
      # Порядок байт обратный: 0100007F — это 127.0.0.1.
      found="$((16#${raw:6:2})).$((16#${raw:4:2})).$((16#${raw:2:2})).$((16#${raw:0:2})):${port}"
    elif [ -r /proc/net/tcp6 ] && awk -v h="$hex" '$4=="0A"{split($2,a,":"); if(a[2]==h){found=1}} END{exit !found}' \
      /proc/net/tcp6 2>/dev/null; then
      found="[::]:${port}"
    fi
  else
    return 2
  fi

  [ -n "$found" ] || return 1
  printf '%s' "$found"
  return 0
}

# Слушает ли порт ТОЛЬКО на петлевом интерфейсе — самая частая причина
# «на сервере открывается, снаружи нет».
is_loopback_only() {
  case "$1" in
    127.0.0.1:*|[::1]:*|0100007F:*) return 0 ;;
    *) return 1 ;;
  esac
}

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time "${2:-8}" "$1" 2>/dev/null
}

external_ip() {
  local ip
  for service in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -sS --max-time 5 "$service" 2>/dev/null | tr -d '[:space:]')"
    case "$ip" in
      *[0-9].[0-9]*) printf '%s' "$ip"; return 0 ;;
    esac
  done
  return 1
}
