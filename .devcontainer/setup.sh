#!/usr/bin/env bash
# Runs once when the codespace is created (run it again by hand after pulling changes):
# Google Chrome and Microsoft Edge, the two browsers the team tests with, and the app's libraries.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEBIAN_FRONTEND=noninteractive

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "Cài Google Chrome..."
  curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get update -q
  sudo -E apt-get install -y -q /tmp/google-chrome.deb fonts-dejavu-core fonts-noto-color-emoji
  rm -f /tmp/google-chrome.deb
fi
google-chrome --version

# Edge comes from Microsoft's apt repository. A failure here only leaves Edge out; Chrome still works.
install_edge() {
  echo "Cài Microsoft Edge..."
  command -v gpg >/dev/null 2>&1 || { sudo apt-get update -q && sudo -E apt-get install -y -q gnupg; }
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | sudo gpg --dearmor --yes -o /usr/share/keyrings/microsoft-edge.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-edge.gpg] https://packages.microsoft.com/repos/edge stable main" \
    | sudo tee /etc/apt/sources.list.d/microsoft-edge.list >/dev/null
  sudo apt-get update -q
  sudo -E apt-get install -y -q microsoft-edge-stable
}
if ! command -v microsoft-edge >/dev/null 2>&1; then
  install_edge || echo "Không cài được Microsoft Edge; EventQA vẫn chạy với Chrome." >&2
fi
command -v microsoft-edge >/dev/null 2>&1 && microsoft-edge --version

echo "Cài thư viện EventQA..."
npm ci --ignore-scripts --no-audit --no-fund
