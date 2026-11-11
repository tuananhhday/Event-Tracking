#!/usr/bin/env bash
# Runs once when the codespace is created: Google Chrome (the browser the team tests with) and the app's libraries.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "Cài Google Chrome..."
  curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get update -q
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q /tmp/google-chrome.deb fonts-dejavu-core fonts-noto-color-emoji
  rm -f /tmp/google-chrome.deb
fi
google-chrome --version

echo "Cài thư viện EventQA..."
npm ci --ignore-scripts --no-audit --no-fund
