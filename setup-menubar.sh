#!/bin/bash
# Installs the Spotify DJ menu bar widget via xbar.
# Requires xbar: brew install --cask xbar

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$HOME/Library/Application Support/xbar/plugins"

if [ ! -d "/Applications/xbar.app" ]; then
  echo "xbar not found. Install it:"
  echo "  brew install --cask xbar"
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
cp "$SCRIPT_DIR/xbar-plugin.sh" "$PLUGIN_DIR/spotify-dj.30s.sh"
chmod +x "$PLUGIN_DIR/spotify-dj.30s.sh"

echo "Installed menu bar plugin."
echo "Open xbar from Applications to see 'DJ: deep-focus' in your menu bar."
