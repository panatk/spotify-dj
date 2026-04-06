# Spotify DJ - Intelligent Music MCP Server

An MCP server that acts as an intelligent DJ, selecting Spotify tracks optimised for different types of cognitive work based on neuroscience research.

## Architecture

```
src/
  index.ts                  — MCP server entry point with 9 tools
  types.ts                  — All TypeScript type definitions
  task-profiles.ts          — Research-based audio parameter profiles per task type
  state-machine.ts          — Core DJ state: transitions, deltas, history, persistence
  spotify-client.ts         — Spotify Web API client (fetch-based, OAuth2, rate-limit handling)
  recommendation-engine.ts  — Bridges state machine with Spotify API for track selection
  context-detection.ts      — macOS context detection via AppleScript
```

## Setup

1. Create a Spotify Developer app at https://developer.spotify.com/dashboard
2. Set the redirect URI to `http://127.0.0.1:8901/callback`
3. Build: `npm install && npm run build`
4. Add to Claude's MCP config:
   ```json
   {
     "mcpServers": {
       "spotify-dj": {
         "command": "node",
         "args": ["/path/to/spotify-dj/dist/index.js"]
       }
     }
   }
   ```
5. Use the `spotify_auth` tool with your client_id and client_secret

## Tools

### spotify_auth
Authenticate with Spotify via OAuth2. Opens browser automatically on macOS.

### spotify_play_for_task
Start a DJ session for a task type: `deep-focus`, `multitasking`, `creative`, `routine`, `energize`, `wind-down`. Optional genre overrides and adjustment reset.

### spotify_adjust
Fine-tune parameters with accumulated offsets: bpm_offset, energy_offset, valence_offset, instrumentalness_offset. Optional skip_current to skip the playing track.

### spotify_current
Get full playback state: current track, audio features, session info, target parameters, transition status.

### spotify_pause
Pause playback while preserving the DJ session.

### spotify_resume
Resume playback with session continuity.

### spotify_set_volume
Set volume 0-100. Includes research-based advice (~70dB sweet spot).

### spotify_queue_next
Fetch fresh recommendations and queue them. Advances transition steps if a task switch is in progress.

### spotify_get_context
Detect macOS context (active app, time, meetings) and suggest the best task type.

## Research Principles

- **Yerkes-Dodson Law**: Optimal performance at moderate arousal. Deep focus needs low arousal; routine tasks tolerate higher.
- **Linguistic interference**: Vocals compete with Broca's area during language/logic tasks. High instrumentalness for focus work.
- **Circadian rhythm**: Energy levels follow a predictable daily cycle. The DJ adapts suggestions based on time of day.
- **Tempo-heart rate coupling**: 50-70 BPM aligns with resting heart rate for calm focus; 120+ BPM elevates arousal for energy.
- **Skip-as-feedback**: Skipped tracks and their genres are penalised, creating an implicit preference learning loop.

## State Persistence

Session state is saved to `~/.spotify-dj/session.json` and restored if less than 12 hours old. Tokens are stored in `~/.spotify-dj/tokens.json`.

## Key Design Decisions

- Uses `fetch` (Node.js built-in) for all HTTP requests — no external HTTP dependencies
- Smooth parameter transitions when switching between task types (3-step linear interpolation)
- Accumulated delta system lets users fine-tune without overriding the research-based profiles
- Fallback chain: Spotify recommendations -> saved tracks matching -> genre-only recommendations
