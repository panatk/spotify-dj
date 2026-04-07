#!/bin/bash
# Installs the Spotify DJ menu bar widget.
# Supports SwiftBar (preferred) or xbar.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -d "/Applications/SwiftBar.app" ]; then
  PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/plugins"
  APP="SwiftBar"
elif [ -d "/Applications/xbar.app" ]; then
  PLUGIN_DIR="$HOME/Library/Application Support/xbar/plugins"
  APP="xbar"
else
  echo "No menu bar app found. Install one:"
  echo "  brew install --cask swiftbar"
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
cp "$SCRIPT_DIR/xbar-plugin.sh" "$PLUGIN_DIR/spotify-dj.30s.sh"
chmod +x "$PLUGIN_DIR/spotify-dj.30s.sh"

echo "Installed menu bar plugin for $APP."
echo "Open $APP and select the plugins folder if prompted:"
echo "  $PLUGIN_DIR"
