#!/bin/bash
input=$(cat)
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
dir_name=$(basename "$cwd")

git_branch=""
if [ -d "$cwd/.git" ] || git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -n "$branch" ]; then
    if ! git -C "$cwd" --no-optional-locks diff --quiet 2>/dev/null || ! git -C "$cwd" --no-optional-locks diff --cached --quiet 2>/dev/null; then
      git_branch=" git:($branch)*"
    else
      git_branch=" git:($branch)"
    fi
  fi
fi

dj_status=""
if [ -f "$HOME/.spotify-dj/status.txt" ]; then
  dj_info=$(cat "$HOME/.spotify-dj/status.txt" 2>/dev/null)
  if [ -n "$dj_info" ]; then
    dj_status=" | $dj_info"
  fi
fi

printf "%s%s%s" "$dir_name" "$git_branch" "$dj_status"
