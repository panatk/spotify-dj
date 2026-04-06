#!/bin/bash
# Adds Spotify DJ status to your Claude Code status line.
# Run once: ./setup-statusline.sh

STATUSLINE_FILE="$HOME/.claude/statusline-command.sh"

if [ ! -f "$STATUSLINE_FILE" ]; then
  echo "No statusline-command.sh found at $STATUSLINE_FILE"
  echo "Creating a basic one..."
  mkdir -p "$HOME/.claude"
  cat > "$STATUSLINE_FILE" << 'SCRIPT'
#!/bin/bash
input=$(cat)
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
dir_name=$(basename "$cwd")

# Spotify DJ status
dj_status=""
if [ -f "$HOME/.spotify-dj/status.txt" ]; then
  dj_info=$(cat "$HOME/.spotify-dj/status.txt" 2>/dev/null)
  if [ -n "$dj_info" ]; then
    dj_status=" \033[33m♪ $dj_info\033[0m"
  fi
fi

printf "\033[1;32m➜\033[0m \033[36m%s\033[0m%b" "$dir_name" "$dj_status"
SCRIPT
  chmod +x "$STATUSLINE_FILE"
  echo "Created $STATUSLINE_FILE with DJ status."
  exit 0
fi

# Check if already patched
if grep -q "spotify-dj/status.txt" "$STATUSLINE_FILE" 2>/dev/null; then
  echo "Status line already has Spotify DJ integration. Nothing to do."
  exit 0
fi

# Patch existing statusline script: insert DJ status block before the final printf
if grep -q 'printf' "$STATUSLINE_FILE"; then
  # Insert the DJ status block before the last printf line
  sed -i.bak '/^printf/i\
# Spotify DJ status\
dj_status=""\
if [ -f "$HOME/.spotify-dj/status.txt" ]; then\
  dj_info=$(cat "$HOME/.spotify-dj/status.txt" 2>/dev/null)\
  if [ -n "$dj_info" ]; then\
    dj_status=" \\033[33m♪ $dj_info\\033[0m"\
  fi\
fi\
' "$STATUSLINE_FILE"

  # Append %b and "$dj_status" to the printf line if not already there
  if ! grep -q 'dj_status' <<< "$(grep '^printf' "$STATUSLINE_FILE")"; then
    sed -i.bak 's/^printf \(.*\)"$/printf \1%b" "$dj_status"/' "$STATUSLINE_FILE"
  fi

  rm -f "${STATUSLINE_FILE}.bak"
  echo "Patched $STATUSLINE_FILE with Spotify DJ status."
  echo "Restart Claude Code to see it."
else
  echo "Could not find printf line in $STATUSLINE_FILE."
  echo "Add this manually before your output line:"
  echo ""
  echo '  dj_status=""'
  echo '  if [ -f "$HOME/.spotify-dj/status.txt" ]; then'
  echo '    dj_info=$(cat "$HOME/.spotify-dj/status.txt" 2>/dev/null)'
  echo '    if [ -n "$dj_info" ]; then'
  echo '      dj_status=" \033[33m♪ $dj_info\033[0m"'
  echo '    fi'
  echo '  fi'
fi
