#!/bin/bash
# Installs the Spotify DJ status line for Claude Code.
# Run once after cloning: ./setup-statusline.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.claude/statusline-command.sh"

mkdir -p "$HOME/.claude"
cp "$SCRIPT_DIR/statusline-command.sh" "$TARGET"
chmod +x "$TARGET"

echo "Installed statusline to $TARGET"
echo "Restart Claude Code to see it."
