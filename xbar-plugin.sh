#!/bin/bash
# Spotify DJ — SwiftBar menu bar plugin

STATUS_FILE="$HOME/.spotify-dj/status.txt"

if [ ! -f "$STATUS_FILE" ] || [ ! -s "$STATUS_FILE" ]; then
  echo "⏸ DJ | color=gray"
  echo "---"
  echo "Spotify DJ is not running"
  echo "Start it in Claude Code: set up spotify dj"
  exit 0
fi

# Read status file — line 1 is mode info, line 2 (if present) is current track
LINE1=$(sed -n '1p' "$STATUS_FILE")
TRACK=$(sed -n '2p' "$STATUS_FILE")

if [ -z "$LINE1" ]; then
  echo "⏸ DJ | color=gray"
  echo "---"
  echo "No active session"
  exit 0
fi

# Break mode
if echo "$LINE1" | grep -q "^BREAK"; then
  echo "☕️ Break | color=#FF9500"
  echo "---"
  echo "$LINE1 | color=#FF9500"
  echo "---"
  echo "Music will resume automatically"
  exit 0
fi

# Extract task mode
MODE=$(echo "$LINE1" | cut -d'(' -f1 | sed 's/ \[auto\]//' | xargs)

# Mode-specific emoji and color
case "$MODE" in
  deep-focus)   EMOJI="🧠"; COLOR="#007AFF" ;;
  creative)     EMOJI="🎨"; COLOR="#AF52DE" ;;
  multitasking) EMOJI="⚡️"; COLOR="#FF9500" ;;
  routine)      EMOJI="🔄"; COLOR="#34C759" ;;
  energize)     EMOJI="🔥"; COLOR="#FF3B30" ;;
  wind-down)    EMOJI="🌙"; COLOR="#5856D6" ;;
  *)            EMOJI="🎵"; COLOR="#FFFFFF" ;;
esac

echo "$EMOJI $MODE | color=$COLOR"
echo "---"
if [ -n "$TRACK" ]; then
  echo "🎵 $TRACK | size=13"
  echo "---"
fi
echo "$LINE1 | size=12 color=gray"
echo "---"
echo "🧠 deep-focus | color=#007AFF"
echo "🎨 creative | color=#AF52DE"
echo "⚡️ multitasking | color=#FF9500"
echo "🔄 routine | color=#34C759"
echo "🔥 energize | color=#FF3B30"
echo "🌙 wind-down | color=#5856D6"
