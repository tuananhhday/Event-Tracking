#!/usr/bin/env bash
# EventQA trong GitHub Codespaces.
#   bash .devcontainer/eventqa.sh start    bật (hoặc bật lại) EventQA + gateway, in link và mã truy cập
#   bash .devcontainer/eventqa.sh info     in lại link và mã truy cập
#   bash .devcontainer/eventqa.sh stop     tắt
#   bash .devcontainer/eventqa.sh logs     xem log gần nhất
# EventQA (bản AI) và noVNC chỉ nghe trong máy; chỉ gateway cổng 8080 được chia sẻ, và nó đòi mã truy cập.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.eventqa"
LOGS="$STATE/logs"
APP_PORT=4174
GATEWAY_PORT=8080
VNC_PORT=6080
mkdir -p "$LOGS" && chmod 700 "$STATE"

public_url() {
  if [ -n "${CODESPACE_NAME:-}" ]; then
    echo "https://${CODESPACE_NAME}-${GATEWAY_PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    echo "http://127.0.0.1:${GATEWAY_PORT}"
  fi
}

# Codespaces secret EVENTQA_ACCESS_KEY if set (≥ 12 ký tự), otherwise a random key kept for this codespace.
key_from_secret() { local value="${EVENTQA_ACCESS_KEY:-}"; [ "${#value}" -ge 12 ]; }
access_key() {
  if [ -n "${EVENTQA_ACCESS_KEY:-}" ] && key_from_secret; then printf '%s' "$EVENTQA_ACCESS_KEY"; return; fi
  if [ ! -s "$STATE/access-key" ]; then
    (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$STATE/access-key")
  fi
  cat "$STATE/access-key"
}

# Chrome's own sandbox works in most codespaces; fall back to --no-sandbox only where it cannot start.
chrome_args() {
  local args="--disable-dev-shm-usage" profile
  profile="$(mktemp -d)"
  if ! timeout 40 google-chrome --headless=new --disable-gpu --user-data-dir="$profile" --dump-dom about:blank >/dev/null 2>&1; then
    args="--no-sandbox $args"
  fi
  rm -rf "$profile"
  echo "$args"
}

# Each service runs in its own process group inside a loop that restarts it if it dies.
run_forever() {
  local name=$1; shift
  if [ -f "$LOGS/$name.log" ] && [ "$(stat -c %s "$LOGS/$name.log")" -gt 5000000 ]; then mv "$LOGS/$name.log" "$LOGS/$name.old.log"; fi
  echo "===== $(date '+%F %T') start =====" >> "$LOGS/$name.log"
  setsid nohup bash -c 'while true; do "$@"; code=$?; echo "[$(date +%T)] dừng (mã $code), bật lại sau 3 giây"; sleep 3; done' _ "$@" \
    >> "$LOGS/$name.log" 2>&1 < /dev/null &
  echo $! > "$STATE/$name.pid"
}

stop_one() {
  local file="$STATE/$1.pid"
  [ -f "$file" ] || return 0
  # SIGTERM lets EventQA save its evidence and close the test Chrome it opened.
  kill -TERM -- "-$(cat "$file")" 2>/dev/null
  rm -f "$file"
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_port() {
  local port=$1 seconds=$2
  for _ in $(seq 1 $((seconds * 2))); do port_open "$port" && return 0; sleep 0.5; done
  return 1
}

stop() {
  stop_one gateway
  stop_one app
  for _ in $(seq 1 30); do port_open "$APP_PORT" || port_open "$GATEWAY_PORT" || break; sleep 0.5; done
}

start() {
  stop
  if ! command -v google-chrome >/dev/null 2>&1; then
    echo "Chưa có Google Chrome. Chạy: bash .devcontainer/setup.sh" >&2
    return 1
  fi
  if [ -n "${EVENTQA_ACCESS_KEY:-}" ] && ! key_from_secret; then
    echo "Secret EVENTQA_ACCESS_KEY ngắn hơn 12 ký tự nên không dùng; tạo mã ngẫu nhiên." >&2
  fi
  cd "$ROOT" || return 1
  export DISPLAY="${DISPLAY:-:1}"
  export EVENTQA_BROWSER_ARGS
  EVENTQA_BROWSER_ARGS="$(chrome_args)"
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then export AI_ENABLED="${AI_ENABLED:-true}"; fi
  run_forever app node --env-file-if-exists=.env src/cli.mjs serve --mode cdp-ai --port "$APP_PORT"

  (
    export EVENTQA_ACCESS_KEY EVENTQA_PUBLIC_URL
    EVENTQA_ACCESS_KEY="$(access_key)"
    EVENTQA_PUBLIC_URL="$(public_url)"
    run_forever gateway node src/cloud/gateway.mjs --port "$GATEWAY_PORT" --app "$APP_PORT" --vnc "$VNC_PORT"
  )

  if ! wait_port "$GATEWAY_PORT" 20; then echo "Gateway chưa chạy. Xem: bash .devcontainer/eventqa.sh logs" >&2; return 1; fi
  if ! wait_port "$APP_PORT" 60; then echo "EventQA chưa chạy. Xem: bash .devcontainer/eventqa.sh logs" >&2; return 1; fi
  if ! port_open "$VNC_PORT"; then echo "Lưu ý: desktop ảo (noVNC cổng $VNC_PORT) chưa chạy, nên /vnc chưa xem được Chrome." >&2; fi
  if [[ "$EVENTQA_BROWSER_ARGS" == *--no-sandbox* ]]; then echo "Chrome chạy với --no-sandbox (máy này không dùng được sandbox của Chrome)."; fi
}

info() {
  local url key
  url="$(public_url)"
  key="$(access_key)"
  echo
  echo "================ EventQA online ================"
  echo "Link EventQA     : $url"
  if [ -n "${EVENTQA_ACCESS_KEY:-}" ] && key_from_secret; then
    echo "Mã truy cập      : (Codespaces secret EVENTQA_ACCESS_KEY)"
  else
    echo "Mã truy cập      : $key"
    echo "Vào nhanh        : $url/login?key=$key"
  fi
  echo "Màn hình Chrome  : $url/vnc   (đăng nhập SSO, thao tác tay)"
  echo
  echo "Để người khác mở được: tab PORTS → chuột phải cổng $GATEWAY_PORT → Port Visibility → Public."
  echo "Chỉ chia sẻ cổng $GATEWAY_PORT. Không đổi cổng $APP_PORT hay $VNC_PORT sang Public."
  echo "================================================"
}

logs() {
  for name in app gateway; do
    echo "----- $name ($LOGS/$name.log) -----"
    tail -n 40 "$LOGS/$name.log" 2>/dev/null || echo "(chưa có log)"
  done
}

case "${1:-start}" in
  start|restart) start && info ;;
  stop) stop && echo "Đã tắt EventQA và gateway." ;;
  info) info ;;
  logs) logs ;;
  *) echo "Dùng: bash .devcontainer/eventqa.sh start|stop|info|logs" >&2; exit 2 ;;
esac
