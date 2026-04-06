# Spotify DJ

An autonomous MCP server that acts as an intelligent DJ for Spotify, selecting and transitioning music to optimize your flow state based on neuroscience research.

It monitors your macOS context — active app, window title, idle state, app switching patterns, Claude Code activity rate, and time of day — then automatically transitions between music modes to match what you're doing.

## How it works

```
You open VS Code          → DJ switches to deep-focus (60-80 BPM, instrumental, minor key)
You switch to Figma        → DJ transitions to creative (100-120 BPM, moderate energy)
You're in Chrome on Gmail  → DJ goes to multitasking (70-90 BPM, balanced)
You browse YouTube         → DJ winds down (50-65 BPM, ambient)
You go idle for 5 min      → DJ pauses. Resumes when you're back.
Every 25 min               → DJ takes a 2.5min silence break (ultradian rhythm)
```

Tracks are filtered by BPM (via Deezer API cross-reference), mixed 70% familiar / 30% discovered, with artist repetition caps and novelty injection.

## The science

| Principle | Application |
|---|---|
| Yerkes-Dodson Law | BPM and energy matched to task arousal needs |
| Linguistic interference (Perham & Currie, 2014) | High instrumentalness during coding/writing |
| Familiarity reduces cognitive load (Pereira et al., 2011) | 70% tracks from your library |
| Ultradian rhythm (Rossi, 1991) | 2.5min silence breaks every 25min |
| Circadian cortisol curve | Energy profile shifts based on your wake time |
| Transient hypofrontality (Dietrich) | Minor key for deep focus reduces emotional salience |
| Habituation (Berlyne, 1971) | Artist caps, exposure decay, surprise track injection |

## Setup

### Prerequisites

- macOS (required for context detection via AppleScript)
- Node.js 18+
- A Spotify Premium account
- A [Spotify Developer app](https://developer.spotify.com/dashboard)
- [Claude Code](https://claude.ai/code) installed

### 1. Create a Spotify Developer app

1. Go to https://developer.spotify.com/dashboard
2. Click **Create app**
3. Fill in any name/description
4. Set **Redirect URI** to `http://127.0.0.1:8901/callback` and click **Add**
5. Save the app
6. On the app page, copy your **Client ID** (shown on the page)
7. Click **Show client secret** and copy your **Client Secret**

You'll need both values in step 3. The same app works on any computer — the redirect URI is localhost.

### 2. Clone and build

```bash
git clone https://github.com/panatk/spotify-dj.git ~/source/spotify-dj
cd ~/source/spotify-dj
npm install
npm run build
```

### 3. Set credentials as environment variables

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
export SPOTIFY_CLIENT_ID="your_client_id_here"
export SPOTIFY_CLIENT_SECRET="your_client_secret_here"
```

Then `source ~/.zshrc`.

### 4. Register the MCP server with Claude Code

```bash
claude mcp add -s user \
  -e SPOTIFY_CLIENT_ID=$SPOTIFY_CLIENT_ID \
  -e SPOTIFY_CLIENT_SECRET=$SPOTIFY_CLIENT_SECRET \
  spotify-dj -- node ~/source/spotify-dj/dist/index.js
```

### 5. Add the activity tracking hook

This lets the DJ monitor your Claude Code usage rate as a signal.

Add to your Claude Code settings (`~/.claude/settings.json`) under `hooks`:

```json
"UserPromptSubmit": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "mkdir -p ~/.spotify-dj && echo \"$(date +%s000)\" >> ~/.spotify-dj/activity.log",
        "async": true
      }
    ]
  }
]
```

### 6. Start Claude Code and authenticate

Open Spotify on your machine (it needs an active device), then in Claude Code:

```
> authenticate spotify
```

Credentials are read from environment variables. A browser window opens for OAuth — approve the connection. Done.

### 7. Start a session

```
> play deep focus music
> turn on autopilot
> set my wake time to 8am
```

## Tools

| Tool | Description |
|---|---|
| `spotify_auth` | Authenticate with Spotify (reads creds from env vars) |
| `spotify_play_for_task` | Start a DJ session for a task type |
| `spotify_adjust` | Fine-tune BPM, energy, valence, instrumentalness |
| `spotify_current` | Show playback state, BPM, session arc, break status |
| `spotify_pause` / `spotify_resume` | Pause/resume with session continuity |
| `spotify_set_volume` | Set volume with research-based advice |
| `spotify_queue_next` | Queue more tracks |
| `spotify_get_context` | Show detected context, app switch rate, idle state |
| `spotify_notifications` | Configure macOS sound + optional ntfy.sh phone push |
| `spotify_set_wake_time` | Calibrate circadian energy curve to your schedule |
| `spotify_autopilot` | Start/stop/status of autonomous mode |

## Task modes

| Mode | BPM | Energy | Key | Use case |
|---|---|---|---|---|
| deep-focus | 60-80 | 0.25 | minor | Coding, writing, complex reasoning |
| multitasking | 70-90 | 0.50 | major | Email, Slack, context-switching |
| creative | 100-120 | 0.65 | major | Design, brainstorming, presentations |
| routine | 120-140 | 0.80 | major | Spreadsheets, data entry, admin |
| energize | 120-150 | 0.90 | major | Pre-work motivation, energy boost |
| wind-down | 50-65 | 0.10 | minor | End of day, relaxation |

## Autopilot decision flow

```
Every 60s:
  1. Check idle (no input for 5min?) → pause music
  2. Check app switch rate (4+ unique apps?) → multitasking mode
  3. Check window title (browser on GitHub?) → deep-focus
  4. Check active app (VS Code?) → deep-focus
  5. Fall back to circadian schedule based on wake time
  6. Apply stability gate (app must be active 90s before switching)
  7. Apply cooldown (5min minimum between switches)
  8. Apply Claude Code activity rate modifier (quiet/normal/high → energy offset)
  9. Apply session energy arc (ramp 15min → sustain → cooldown 10min)
  10. Filter tracks by BPM via Deezer, sort by proximity to target
```

## Architecture

```
src/
  index.ts                  — MCP server, 12 tools, background monitors
  types.ts                  — TypeScript type definitions
  task-profiles.ts          — Research-based audio profiles per task type
  state-machine.ts          — DJ state, transitions, breaks, artist caps, exposure
  spotify-client.ts         — Spotify Web API client (OAuth2, rate limiting)
  recommendation-engine.ts  — Track selection with familiarity mixing + BPM filtering
  bpm-lookup.ts             — BPM lookup via Deezer API with disk cache
  context-detection.ts      — macOS context: app, window title, idle, switch rate
  autopilot.ts              — Autonomous mode with hysteresis and stability gates
  activity-tracker.ts       — Claude Code prompt rate tracking
  playback-monitor.ts       — Skip/completion detection via playback polling
  notifier.ts               — macOS sound + ntfy.sh push notifications
```

## Tests

```bash
npm test        # run once
npm run test:watch  # watch mode
```

108 tests across 9 test files covering state machine, task profiles, context detection, BPM filtering, playback monitoring, autopilot hysteresis, and notifications.

## Security

- All credentials stored with `0600` permissions in `~/.spotify-dj/`
- OAuth callback binds to `127.0.0.1` only (not network-accessible)
- Spotify API scopes are minimal (read playback + modify playback only)
- No playlist write access, no profile/email access
- Credentials read from environment variables (not conversation logs)
- BPM lookups via Deezer send only artist + title (no auth, no user ID)

## License

Private — not yet licensed for distribution.
