#!/bin/bash
# Spotify DJ — xbar menu bar plugin
# Shows current DJ mode, why it chose it, and break countdown

STATUS_FILE="$HOME/.spotify-dj/status.txt"

if [ ! -f "$STATUS_FILE" ]; then
  echo "DJ: off"
  echo "---"
  echo "Spotify DJ is not running"
  echo "Start it in Claude Code: set up spotify dj"
  exit 0
fi

STATUS=$(cat "$STATUS_FILE" 2>/dev/null)

if [ -z "$STATUS" ]; then
  echo "DJ: off"
  echo "---"
  echo "No active session"
  exit 0
fi

# Check if on break
if echo "$STATUS" | grep -q "^BREAK"; then
  echo "DJ: break"
  echo "---"
  echo "$STATUS"
  exit 0
fi

# Extract task mode (first word)
MODE=$(echo "$STATUS" | cut -d'(' -f1 | xargs)

# Show short version in menu bar
echo "DJ: $MODE"

# Dropdown with full details
echo "---"
echo "$STATUS"
echo "---"
echo "Modes: deep-focus | creative | multitasking | routine | energize | wind-down"
