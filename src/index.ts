#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { SpotifyClient } from './spotify-client.js';
import {
  createInitialState,
  transitionToTask,
  advanceTransition,
  applyAdjustment,
  recordTrack,
  getRecentTrackIds,
  getSessionDuration,
  saveSession,
  loadSession,
  resetDeltas,
  shouldTakeBreak,
  isBreakOver,
  startBreak,
  endBreak,
  resetSurpriseCounter,
  getArcModifier,
} from './state-machine.js';
import { TASK_PROFILES, DEFAULT_GENRE_SEEDS, profileRationale } from './task-profiles.js';
import { getRecommendations } from './recommendation-engine.js';
import { detectMacOSContext, suggestTaskFromContext } from './context-detection.js';
import { createAutopilotState, pollContext, AutopilotState } from './autopilot.js';
import { PlaybackMonitor } from './playback-monitor.js';
import { notify, createDefaultNotifierConfig, NotifierConfig } from './notifier.js';
import { lookupBPM, getCacheStats } from './bpm-lookup.js';
import { TaskType, DJState } from './types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const STATUS_FILE = path.join(os.homedir(), '.spotify-dj', 'status.txt');

// What triggered the current mode (shown in status line)
let lastDecisionReason: string = '';
let currentTrackForStatus: string = '';

function updateStatusLine(): void {
  try {
    if (!djState.currentTask) {
      fs.writeFileSync(STATUS_FILE, '', { encoding: 'utf-8', mode: 0o600 });
      return;
    }

    const onBreak = djState.breakState.isOnBreak;
    if (onBreak) {
      const elapsed = djState.breakState.breakStartedAt
        ? Math.round((Date.now() - djState.breakState.breakStartedAt) / 1000)
        : 0;
      const remaining = Math.max(0, Math.round(djState.breakState.breakDurationMs / 1000) - elapsed);
      fs.writeFileSync(STATUS_FILE, `BREAK ${remaining}s remaining`, { encoding: 'utf-8', mode: 0o600 });
      return;
    }

    const task = djState.currentTask;
    const arc = getArcModifier(djState);

    // Time until break
    let breakInfo = '';
    const cycleStart = djState.workCycleStartedAt;
    if (cycleStart) {
      const elapsed = Date.now() - cycleStart;
      const remaining = Math.max(0, djState.breakState.breakIntervalMs - elapsed);
      const mins = Math.round(remaining / 60_000);
      breakInfo = mins <= 2 ? ' | break soon' : ` | break ${mins}m`;
    }

    // Why we're in this mode
    const reason = lastDecisionReason ? ` (${lastDecisionReason})` : '';

    const track = currentTrackForStatus ? `\n${currentTrackForStatus}` : '';
    const status = `${task}${reason} | ${arc.phase}${breakInfo}${track}`;
    fs.writeFileSync(STATUS_FILE, status, { encoding: 'utf-8', mode: 0o600 });
  } catch { /* non-critical */ }
}

// ── Global mutable state ─────────────────────────────────────────────

const spotify = new SpotifyClient();
let djState: DJState = loadSession() ?? createInitialState();
let autopilotState: AutopilotState = createAutopilotState();
let autopilotTimer: ReturnType<typeof setInterval> | null = null;
const playbackMonitor = new PlaybackMonitor(spotify);
let notifierConfig: NotifierConfig = createDefaultNotifierConfig();

function persist(): void {
  saveSession(djState);
  updateStatusLine();
}

// ── P1: Playback monitor — skip depth tracking ─────────────────────

let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;

function startPlaybackMonitor(): void {
  // Refresh status line every 30s (break countdown, arc phase, current track)
  if (statusRefreshTimer) clearInterval(statusRefreshTimer);
  statusRefreshTimer = setInterval(async () => {
    try {
      const playback = await spotify.getPlaybackState();
      if (playback?.item) {
        const artist = playback.item.artists[0]?.name ?? '';
        currentTrackForStatus = `${playback.item.name} - ${artist}`;
      }
    } catch { /* non-critical */ }
    updateStatusLine();
  }, 30_000);

  playbackMonitor.start((event) => {
    const depthLabel = event.wasSkipped
      ? `skipped at ${Math.round(event.skipDepth * 100)}%`
      : `completed (${Math.round(event.skipDepth * 100)}%)`;
    console.error(`[playback-monitor] Track ended: "${event.previousTrackName}" — ${depthLabel}`);

    djState = recordTrack(djState, {
      trackId: event.previousTrackId,
      trackName: event.previousTrackName,
      artist: event.previousArtist,
      artistIds: event.previousArtistIds,
      playedAt: Date.now(),
      taskType: djState.currentTask ?? 'deep-focus',
      wasSkipped: event.wasSkipped,
      skipDepth: event.skipDepth,
      genre: DEFAULT_GENRE_SEEDS[djState.currentTask ?? 'deep-focus']?.[0],
    });

    // P2: Reset surprise counter on surprise tracks
    if (djState.tracksSinceSurprise >= 5) {
      djState = resetSurpriseCounter(djState);
    }

    persist();
  });
}

// ── P0: Break management ────────────────────────────────────────────

let breakTimer: ReturnType<typeof setInterval> | null = null;

function startBreakMonitor(): void {
  if (breakTimer) clearInterval(breakTimer);
  breakTimer = setInterval(async () => {
    if (!spotify.isAuthenticated() || !djState.currentTask) return;

    // Check if it's time for a break
    if (shouldTakeBreak(djState) && !djState.breakState.isOnBreak) {
      console.error(`[break] Starting silence break (#${djState.breakState.totalBreaksTaken + 1})`);
      djState = startBreak(djState);
      persist();
      notify(
        notifierConfig,
        'DJ: Silence Break',
        `Take a breather. Music resumes in ${Math.round(djState.breakState.breakDurationMs / 60000)} min.`,
      ).catch(() => {});
      try {
        await spotify.pause();
      } catch { /* already paused */ }
      return;
    }

    // Check if break is over
    if (djState.breakState.isOnBreak && isBreakOver(djState)) {
      console.error('[break] Break over — resuming playback');
      djState = endBreak(djState);
      persist();
      notify(
        notifierConfig,
        'DJ: Back to Work',
        `Break over — resuming ${djState.currentTask} music.`,
      ).catch(() => {});
      try {
        await spotify.play();
      } catch (e) {
        console.error('[break] Error resuming:', e instanceof Error ? e.message : e);
      }
    }
  }, 10_000); // check every 10s
}

// ── Autopilot background loop ───────────────────────────────────────

async function autopilotTick(): Promise<void> {
  if (!autopilotState.enabled || !spotify.isAuthenticated() || !djState.currentTask) {
    return;
  }

  // Don't switch during a break
  if (djState.breakState.isOnBreak) return;

  const { result, newState } = pollContext(
    autopilotState,
    djState.currentTask,
    djState.circadianConfig.wakeTimeHour,
  );
  autopilotState = newState;

  // Idle detection: pause music when user is away, resume when back
  if (result.isIdle) {
    try {
      const playback = await spotify.getPlaybackState();
      if (playback?.is_playing) {
        console.error(`[autopilot] User idle (${result.idleSeconds}s) — pausing music`);
        await spotify.pause();
      }
    } catch { /* already paused */ }
    return;
  }

  // If we were idle and now we're back, resume
  try {
    const playback = await spotify.getPlaybackState();
    if (playback && !playback.is_playing && !djState.breakState.isOnBreak) {
      console.error('[autopilot] User returned from idle — resuming music');
      await spotify.play();
      notify(notifierConfig, 'DJ: Welcome back', `Resuming ${djState.currentTask} music.`).catch(() => {});
    }
  } catch { /* best effort */ }

  if (!result.shouldSwitch || !result.suggestedTask) return;

  console.error(`[autopilot] Switching: ${djState.currentTask} → ${result.suggestedTask} (app: ${result.activeApp}, activity: ${result.activityLevel} [${result.activityCount} msgs/10min])`);
  lastDecisionReason = result.activeApp;

  notify(
    notifierConfig,
    `DJ: ${result.suggestedTask}`,
    `Switching from ${djState.currentTask} → ${result.suggestedTask} (${result.activeApp})`,
  ).catch(() => {});

  try {
    djState = transitionToTask(djState, result.suggestedTask);

    // Apply activity-based adjustments
    if (result.activityEnergyOffset !== 0 || result.activityBpmOffset !== 0) {
      djState = applyAdjustment(djState, {
        bpmOffset: result.activityBpmOffset,
        energyOffset: result.activityEnergyOffset,
        valenceOffset: 0,
        instrumentalnessOffset: 0,
      });
    }

    persist();

    const recs = await getRecommendations(spotify, djState);
    if (recs.tracks.length > 0) {
      const uris = recs.tracks.map((t) => t.uri);
      await spotify.play(uris);

      djState = recordTrack(djState, {
        trackId: recs.tracks[0].id,
        trackName: recs.tracks[0].name,
        artist: recs.tracks[0].artists.map((a) => a.name).join(', '),
        artistIds: recs.tracks[0].artists.map((a) => a.id),
        playedAt: Date.now(),
        taskType: result.suggestedTask,
        wasSkipped: false,
      });
      persist();
    }
  } catch (err) {
    console.error(`[autopilot] Error during switch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startAutopilot(): void {
  stopAutopilot();
  autopilotState.enabled = true;
  autopilotTimer = setInterval(() => {
    autopilotTick().catch((e) => console.error('[autopilot] tick error:', e));
  }, autopilotState.pollIntervalMs);
  // Run first tick immediately
  autopilotTick().catch((e) => console.error('[autopilot] tick error:', e));
}

function stopAutopilot(): void {
  autopilotState.enabled = false;
  if (autopilotTimer) {
    clearInterval(autopilotTimer);
    autopilotTimer = null;
  }
}

const TASK_TYPES: TaskType[] = [
  'deep-focus',
  'multitasking',
  'creative',
  'routine',
  'energize',
  'wind-down',
];

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

// ── MCP server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: 'spotify-dj',
  version: '1.0.0',
});

// ── Tool 0: spotify_setup (guided onboarding) ──────────────────────

server.tool(
  'spotify_setup',
  'Guided first-run setup. Handles authentication, wake time, and starts your first session. If already authenticated, skips straight to playing.',
  {
    client_id: z.string().optional().describe('Spotify app client ID (or set SPOTIFY_CLIENT_ID env var)'),
    client_secret: z.string().optional().describe('Spotify app client secret (or set SPOTIFY_CLIENT_SECRET env var)'),
    wake_hour: z.number().min(0).max(23).optional().describe('Your typical wake time hour (0-23, e.g. 7 for 7am)'),
    task: z
      .enum(['deep-focus', 'multitasking', 'creative', 'routine', 'energize', 'wind-down'])
      .optional()
      .describe('Task type to start with (default: auto-detected from your current context)'),
    enable_autopilot: z.boolean().optional().describe('Enable autopilot immediately (default: true)'),
  },
  async ({ client_id, client_secret, wake_hour, task, enable_autopilot }) => {
    const steps: string[] = [];

    // ── Step 1: Authentication ──────────────────────────────────
    if (spotify.isAuthenticated()) {
      steps.push('Already authenticated with Spotify.');
    } else {
      const resolvedId = process.env.SPOTIFY_CLIENT_ID ?? client_id;
      const resolvedSecret = process.env.SPOTIFY_CLIENT_SECRET ?? client_secret;

      if (!resolvedId || !resolvedSecret) {
        return {
          content: [{
            type: 'text' as const,
            text: [
              'Welcome to Spotify DJ.',
              '',
              'First, you need a Spotify Developer app. This takes 2 minutes',
              'and means your music data stays between you and Spotify — no middleman.',
              '',
              '1. Go to https://developer.spotify.com/dashboard',
              '2. Click "Create app" — any name/description works',
              '3. Set Redirect URI to: http://127.0.0.1:8901/callback',
              '4. Save, then copy your Client ID and Client Secret',
              '',
              'Then run this again with your credentials:',
              '  client_id: "your_id"',
              '  client_secret: "your_secret"',
              '',
              'Or set them as environment variables (recommended):',
              '  export SPOTIFY_CLIENT_ID="your_id"',
              '  export SPOTIFY_CLIENT_SECRET="your_secret"',
              '',
              'Why a developer app? Your tokens stay on your machine.',
              'We never see your credentials. You own your data.',
            ].join('\n'),
          }],
        };
      }

      try {
        await spotify.authorize(resolvedId, resolvedSecret);
        steps.push('Spotify connected. Your tokens are stored locally at ~/.spotify-dj/');
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }

    // ── Step 2: Wake time ───────────────────────────────────────
    if (wake_hour !== undefined) {
      djState = {
        ...djState,
        circadianConfig: { wakeTimeHour: wake_hour, wakeTimeMinute: 0 },
      };
      persist();
      steps.push(`Wake time set to ${wake_hour}:00. Music energy follows your circadian rhythm.`);
    } else if (djState.circadianConfig.wakeTimeHour === 7) {
      steps.push('Wake time: 7:00 AM (default). Use spotify_set_wake_time to adjust.');
    }

    // ── Step 3: Detect context and start playing ────────────────
    let selectedTask = task;
    if (!selectedTask) {
      const ctx = detectMacOSContext();
      const suggestion = suggestTaskFromContext(ctx, djState.circadianConfig.wakeTimeHour);
      selectedTask = suggestion.suggestedTask;
      lastDecisionReason = ctx.activeApp;
      steps.push(`Context detected: ${ctx.activeApp} → ${selectedTask} mode. ${suggestion.reasoning}`);
    }

    try {
      if (reset_adjustments_needed()) {
        djState = resetDeltas(djState);
      }
      djState = transitionToTask(djState, selectedTask);
      persist();

      const result = await getRecommendations(spotify, djState);
      if (result.tracks.length === 0) {
        steps.push('No tracks found — open Spotify and play something first, then try again.');
        return { content: [{ type: 'text' as const, text: steps.join('\n\n') }] };
      }

      const uris = result.tracks.map((t) => t.uri);
      await spotify.play(uris);

      const first = result.tracks[0];
      djState = recordTrack(djState, {
        trackId: first.id,
        trackName: first.name,
        artist: first.artists.map((a) => a.name).join(', '),
        artistIds: first.artists.map((a) => a.id),
        playedAt: Date.now(),
        taskType: selectedTask,
        wasSkipped: false,
      });
      djState = { ...djState, workCycleStartedAt: djState.workCycleStartedAt ?? Date.now() };
      currentTrackForStatus = `${first.name} - ${first.artists[0]?.name ?? ''}`;
      persist();

      startPlaybackMonitor();
      startBreakMonitor();

      const trackList = result.tracks
        .slice(0, 5)
        .map((t, i) => `  ${i + 1}. ${t.name} — ${t.artists.map((a) => a.name).join(', ')}`)
        .join('\n');

      steps.push(`Now playing (${selectedTask}):\n${trackList}`);
    } catch (error) {
      steps.push(`Error starting playback: ${error instanceof Error ? error.message : String(error)}`);
      return { content: [{ type: 'text' as const, text: steps.join('\n\n') }] };
    }

    // ── Step 4: Autopilot ───────────────────────────────────────
    if (enable_autopilot !== false) {
      startAutopilot();
      steps.push(
        'Autopilot is ON. The DJ is watching your screen and will transition ' +
        'the music as you switch between apps. A silence break happens every ' +
        '25 minutes to keep your focus sharp (ultradian rhythm).',
      );
    }

    // ── Step 5: Science summary ─────────────────────────────────
    const profile = TASK_PROFILES[selectedTask];
    steps.push([
      `The science: ${selectedTask} mode uses ${profile.minBPM}-${profile.maxBPM} BPM, ` +
      `${profile.energy < 0.4 ? 'low' : profile.energy < 0.7 ? 'moderate' : 'high'} energy, ` +
      `${profile.instrumentalness > 0.7 ? 'mostly instrumental' : 'with vocals'}. ` +
      `${profile.mode === 0 ? 'Minor key reduces emotional salience.' : 'Major key supports positive mood.'}`,
      '',
      'Just work. The DJ handles the rest.',
    ].join('\n'));

    return { content: [{ type: 'text' as const, text: steps.join('\n\n') }] };
  },
);

function reset_adjustments_needed(): boolean {
  const d = djState.parameterDeltas;
  return d.bpmOffset !== 0 || d.energyOffset !== 0 || d.valenceOffset !== 0 || d.instrumentalnessOffset !== 0;
}

// ── Tool 1: spotify_auth ─────────────────────────────────────────────

server.tool(
  'spotify_auth',
  'Authenticate with Spotify using OAuth2. Reads credentials from SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables if set, otherwise accepts them as parameters. Requires a Spotify Developer app (https://developer.spotify.com/dashboard) with redirect URI set to http://127.0.0.1:8901/callback.',
  {
    client_id: z.string().optional().describe('Spotify app client ID (or set SPOTIFY_CLIENT_ID env var)'),
    client_secret: z.string().optional().describe('Spotify app client secret (or set SPOTIFY_CLIENT_SECRET env var)'),
  },
  async ({ client_id, client_secret }) => {
    const resolvedId = process.env.SPOTIFY_CLIENT_ID ?? client_id;
    const resolvedSecret = process.env.SPOTIFY_CLIENT_SECRET ?? client_secret;

    if (!resolvedId || !resolvedSecret) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Missing credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables, or pass them as parameters.',
        }],
        isError: true,
      };
    }

    try {
      const msg = await spotify.authorize(resolvedId, resolvedSecret);
      return {
        content: [{
          type: 'text' as const,
          text: `${msg}\n\nYou can now use spotify_play_for_task to start a DJ session.\nAvailable task types: ${TASK_TYPES.join(', ')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 2: spotify_play_for_task ────────────────────────────────────

server.tool(
  'spotify_play_for_task',
  'Start an intelligent DJ session optimised for a specific cognitive task. Selects music based on neuroscience research about how tempo, energy, instrumentalness, and valence affect different types of work.',
  {
    task: z
      .enum(['deep-focus', 'multitasking', 'creative', 'routine', 'energize', 'wind-down'])
      .describe('Type of cognitive task'),
    genre_seeds: z
      .array(z.string())
      .optional()
      .describe('Optional genre overrides (max 5). Defaults to research-based genres for the task.'),
    reset_adjustments: z
      .boolean()
      .optional()
      .describe('If true, reset any accumulated parameter adjustments before starting'),
  },
  async ({ task, genre_seeds, reset_adjustments }) => {
    if (!spotify.isAuthenticated()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Not authenticated. Please run spotify_auth first.',
        }],
        isError: true,
      };
    }

    try {
      // Reset deltas if requested
      if (reset_adjustments) {
        djState = resetDeltas(djState);
      }

      // Transition to the new task (smooth ramp if switching)
      djState = transitionToTask(djState, task);
      persist();

      // Get recommendations
      const result = await getRecommendations(spotify, djState);

      if (result.tracks.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No tracks found matching the criteria. Try different genre_seeds or check your Spotify account has listening history.',
          }],
          isError: true,
        };
      }

      // FIX #4: Play all URIs at once
      const uris = result.tracks.map((t) => t.uri);
      await spotify.play(uris);

      // Record the first track
      const first = result.tracks[0];
      djState = recordTrack(djState, {
        trackId: first.id,
        trackName: first.name,
        artist: first.artists.map((a) => a.name).join(', '),
        artistIds: first.artists.map((a) => a.id),
        playedAt: Date.now(),
        taskType: task,
        wasSkipped: false,
      });
      djState = { ...djState, workCycleStartedAt: djState.workCycleStartedAt ?? Date.now() };
      currentTrackForStatus = `${first.name} - ${first.artists[0]?.name ?? ''}`;
      persist();

      // Start background monitors
      startPlaybackMonitor();
      startBreakMonitor();

      const trackList = result.tracks
        .slice(0, 10)
        .map((t, i) => `  ${i + 1}. ${t.name} - ${t.artists.map((a) => a.name).join(', ')}`)
        .join('\n');

      const profile = TASK_PROFILES[task];
      const rationale = profileRationale(task);
      const genres = genre_seeds ?? DEFAULT_GENRE_SEEDS[task];
      const transitionNote = djState.isTransitioning
        ? `\n\nSmooth transition in progress (${djState.transitionQueue.length} steps remaining). Use spotify_queue_next to advance.`
        : '';

      return {
        content: [{
          type: 'text' as const,
          text: [
            `DJ Session: ${task}`,
            `Source: ${result.source}`,
            `BPM: ${profile.minBPM}-${profile.maxBPM} (target ${profile.targetBPM})`,
            `Energy: ${profile.energy} | Valence: ${profile.valence} | Instrumentalness: ${profile.instrumentalness}`,
            `Genres: ${genres.join(', ')}`,
            '',
            `Now playing:`,
            trackList,
            '',
            `Science: ${rationale}`,
            transitionNote,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error starting DJ session: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 3: spotify_adjust ───────────────────────────────────────────

server.tool(
  'spotify_adjust',
  'Fine-tune the DJ parameters with accumulated offsets. Adjustments persist across track changes within the same task. Use skip_current to also skip the currently playing track.',
  {
    bpm_offset: z.number().optional().describe('Add/subtract from target BPM (e.g., +10 or -5)'),
    energy_offset: z.number().optional().describe('Adjust energy level (-1 to +1 scale, e.g., +0.1)'),
    valence_offset: z.number().optional().describe('Adjust musical positiveness (-1 to +1 scale)'),
    instrumentalness_offset: z
      .number()
      .optional()
      .describe('Adjust instrumentalness preference (-1 to +1 scale)'),
    skip_current: z.boolean().optional().describe('Also skip the current track'),
  },
  async ({ bpm_offset, energy_offset, valence_offset, instrumentalness_offset, skip_current }) => {
    if (!djState.currentTask) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No active DJ session. Start one with spotify_play_for_task first.',
        }],
        isError: true,
      };
    }

    djState = applyAdjustment(djState, {
      bpmOffset: bpm_offset ?? 0,
      energyOffset: energy_offset ?? 0,
      valenceOffset: valence_offset ?? 0,
      instrumentalnessOffset: instrumentalness_offset ?? 0,
    });

    if (skip_current) {
      // Record current track as skipped
      if (djState.currentTrackId) {
        const playback = await spotify.getPlaybackState();
        const trackName = playback?.item?.name ?? 'Unknown';
        const artist = playback?.item?.artists.map((a) => a.name).join(', ') ?? 'Unknown';
        const artistIds = playback?.item?.artists.map((a) => a.id) ?? [];
        const skipDepth = (playback && playback.item)
          ? playback.progress_ms / playback.item.duration_ms
          : 0;
        const genre = DEFAULT_GENRE_SEEDS[djState.currentTask!]?.[0];
        djState = recordTrack(djState, {
          trackId: djState.currentTrackId,
          trackName,
          artist,
          artistIds,
          playedAt: Date.now(),
          taskType: djState.currentTask!,
          wasSkipped: true,
          skipDepth,
          genre,
        });
      }
      await spotify.skipToNext();
    }

    persist();

    const params = djState.currentParams;
    const deltas = djState.parameterDeltas;

    return {
      content: [{
        type: 'text' as const,
        text: [
          'Adjustments applied.',
          '',
          `Accumulated deltas:`,
          `  BPM offset: ${deltas.bpmOffset > 0 ? '+' : ''}${deltas.bpmOffset}`,
          `  Energy offset: ${deltas.energyOffset > 0 ? '+' : ''}${deltas.energyOffset.toFixed(2)}`,
          `  Valence offset: ${deltas.valenceOffset > 0 ? '+' : ''}${deltas.valenceOffset.toFixed(2)}`,
          `  Instrumentalness offset: ${deltas.instrumentalnessOffset > 0 ? '+' : ''}${deltas.instrumentalnessOffset.toFixed(2)}`,
          '',
          params
            ? `Effective params: BPM ${params.targetBPM}, energy ${params.energy.toFixed(2)}, valence ${params.valence.toFixed(2)}, instrumentalness ${params.instrumentalness.toFixed(2)}`
            : '',
          skip_current ? '\nSkipped current track.' : '',
          '\nNew recommendations will use these adjusted parameters.',
        ].join('\n'),
      }],
    };
  },
);

// ── Tool 4: spotify_current ──────────────────────────────────────────

server.tool(
  'spotify_current',
  'Get current playback state, session info, and transition status.',
  {},
  async () => {
    if (!spotify.isAuthenticated()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Not authenticated. Please run spotify_auth first.',
        }],
        isError: true,
      };
    }

    try {
      const playback = await spotify.getPlaybackState();
      const sessionDur = getSessionDuration(djState);

      // Look up BPM via Deezer (cached)
      let bpmText = '';
      if (playback?.item) {
        try {
          const artist = playback.item.artists.map((a) => a.name).join(', ');
          const bpm = await lookupBPM(artist, playback.item.name);
          const target = djState.currentParams?.targetBPM;
          if (bpm) {
            const diff = target ? ` (target: ${target}, diff: ${bpm > target ? '+' : ''}${Math.round(bpm - target)})` : '';
            bpmText = `\nBPM: ${bpm.toFixed(1)}${diff}`;
          }
        } catch { /* non-critical */ }
      }

      const playbackText = playback
        ? [
            `Now playing: ${playback.item?.name ?? 'Nothing'} - ${playback.item?.artists.map((a) => a.name).join(', ') ?? 'Unknown'}`,
            `Status: ${playback.is_playing ? 'Playing' : 'Paused'}`,
            `Progress: ${formatMs(playback.progress_ms)} / ${playback.item ? formatMs(playback.item.duration_ms) : 'N/A'}`,
            `Device: ${playback.device?.name ?? 'Unknown'} (${playback.device?.type ?? 'unknown'})`,
            `Volume: ${playback.device?.volume_percent ?? 'N/A'}%`,
            `Shuffle: ${playback.shuffle_state ? 'On' : 'Off'}`,
          ].join('\n')
        : 'No active playback detected.';

      const sessionText = [
        '',
        'Session info:',
        `  Task: ${djState.currentTask ?? 'None'}`,
        `  Duration: ${formatMs(sessionDur)}`,
        `  Tracks played: ${djState.playbackHistory.length}`,
        `  Tracks skipped: ${djState.playbackHistory.filter((t) => t.wasSkipped).length}`,
        djState.previousTask ? `  Previous task: ${djState.previousTask}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const transitionText = djState.isTransitioning
        ? `\n\nTransition in progress: ${djState.transitionQueue.length} steps remaining`
        : '';

      const paramsText = djState.currentParams
        ? [
            '',
            'Target parameters:',
            `  BPM: ${djState.currentParams.targetBPM} (${djState.currentParams.minBPM}-${djState.currentParams.maxBPM})`,
            `  Energy: ${djState.currentParams.energy.toFixed(2)}`,
            `  Valence: ${djState.currentParams.valence.toFixed(2)}`,
            `  Instrumentalness: ${djState.currentParams.instrumentalness.toFixed(2)}`,
          ].join('\n')
        : '';

      // P1: Session energy arc
      const arc = getArcModifier(djState);
      const { ratio, reasoning: familiarityReasoning } = (await import('./recommendation-engine.js')).calculateFamiliarityRatio(djState);
      const arcText = [
        '',
        'Session arc:',
        `  Phase: ${arc.phase}`,
        `  Energy multiplier: ${arc.energyMultiplier.toFixed(2)}x`,
        `  Familiarity: ${Math.round(ratio * 100)}% familiar / ${Math.round((1 - ratio) * 100)}% discovery`,
        `  (${familiarityReasoning})`,
      ].join('\n');

      // P0: Break state
      const breakText = djState.breakState.isOnBreak
        ? '\n\nSilence break in progress...'
        : `\n\nBreaks taken: ${djState.breakState.totalBreaksTaken}`;

      return {
        content: [{
          type: 'text' as const,
          text: playbackText + bpmText + sessionText + paramsText + arcText + breakText + transitionText,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting current state: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 5: spotify_pause ────────────────────────────────────────────

server.tool(
  'spotify_pause',
  'Pause playback. The DJ session is preserved and can be resumed.',
  {},
  async () => {
    if (!spotify.isAuthenticated()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Not authenticated. Please run spotify_auth first.',
        }],
        isError: true,
      };
    }

    try {
      await spotify.pause();
      persist();
      const dur = formatMs(getSessionDuration(djState));
      return {
        content: [{
          type: 'text' as const,
          text: `Playback paused. Session preserved (${dur} elapsed, ${djState.playbackHistory.length} tracks played).\nUse spotify_resume to continue.`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error pausing: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 6: spotify_resume ───────────────────────────────────────────

server.tool(
  'spotify_resume',
  'Resume playback with session continuity. The DJ remembers the current task and parameters.',
  {},
  async () => {
    if (!spotify.isAuthenticated()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Not authenticated. Please run spotify_auth first.',
        }],
        isError: true,
      };
    }

    try {
      await spotify.play();
      return {
        content: [{
          type: 'text' as const,
          text: [
            'Playback resumed.',
            djState.currentTask ? `Task: ${djState.currentTask}` : '',
            `Session duration: ${formatMs(getSessionDuration(djState))}`,
          ]
            .filter(Boolean)
            .join('\n'),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error resuming: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 7: spotify_set_volume ───────────────────────────────────────

server.tool(
  'spotify_set_volume',
  'Set playback volume (0-100). Research suggests ~60-70% volume (~70dB) is the sweet spot for focus — loud enough to mask distractions but not so loud as to become one.',
  {
    volume: z.number().min(0).max(100).describe('Volume level 0-100'),
  },
  async ({ volume }) => {
    if (!spotify.isAuthenticated()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Not authenticated. Please run spotify_auth first.',
        }],
        isError: true,
      };
    }

    try {
      await spotify.setVolume(volume);

      let advice = '';
      if (volume < 30) {
        advice =
          '\n\nNote: Very low volume may not provide enough stimulation to benefit from the DJ\'s audio targeting. Consider raising to 40-60%.';
      } else if (volume > 80) {
        advice =
          '\n\nNote: High volume (>80dB equivalent) can impair complex cognitive tasks (Mehta et al., 2012). Consider lowering to 60-70% for focus work.';
      } else if (volume >= 55 && volume <= 75) {
        advice =
          '\n\nGood choice. Research indicates ~70dB is optimal for balancing focus and distraction masking (Mehta et al., 2012).';
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Volume set to ${volume}%.${advice}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error setting volume: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 8: spotify_queue_next ───────────────────────────────────────

server.tool(
  'spotify_queue_next',
  'Fetch fresh recommendations and add them to the queue. If a transition is in progress, advances one step. Useful for keeping the queue full or progressing through a task switch.',
  {
    count: z.number().optional().describe('Number of tracks to queue (default: 5, max: 20)'),
  },
  async ({ count }) => {
    if (!spotify.isAuthenticated()) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Not authenticated. Please run spotify_auth first.',
        }],
        isError: true,
      };
    }

    if (!djState.currentTask) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No active DJ session. Start one with spotify_play_for_task first.',
        }],
        isError: true,
      };
    }

    try {
      // Advance transition if in progress
      if (djState.isTransitioning) {
        djState = advanceTransition(djState);
        persist();
      }

      // Get fresh recommendations with current (possibly transitioned) params
      const result = await getRecommendations(spotify, djState);

      const numToQueue = Math.min(count ?? 5, 20, result.tracks.length);
      const toQueue = result.tracks.slice(0, numToQueue);

      // Queue each track
      for (const track of toQueue) {
        await spotify.addToQueue(track.uri);
      }

      const trackList = toQueue
        .map((t, i) => `  ${i + 1}. ${t.name} - ${t.artists.map((a) => a.name).join(', ')}`)
        .join('\n');

      const transitionNote = djState.isTransitioning
        ? `\nTransition: ${djState.transitionQueue.length} steps remaining`
        : djState.transitionQueue.length === 0 && djState.previousTask
          ? '\nTransition complete — now at target parameters.'
          : '';

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Queued ${toQueue.length} tracks (source: ${result.source}):`,
            trackList,
            transitionNote,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error queuing tracks: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ── Tool 9: spotify_get_context ──────────────────────────────────────

server.tool(
  'spotify_get_context',
  'Detect the current macOS context (active app, time, meeting status) and suggest the best task type. Also reports current DJ session state.',
  {},
  async () => {
    const ctx = detectMacOSContext();
    const suggestion = suggestTaskFromContext(ctx, djState.circadianConfig.wakeTimeHour);
    const sessionDur = getSessionDuration(djState);

    const { uniqueApps, isHighChurn } = (await import('./context-detection.js')).getAppSwitchRate();

    const contextLines = [
      'macOS Context:',
      `  Active app: ${ctx.activeApp}`,
      ctx.windowTitle ? `  Window: ${ctx.windowTitle}` : '',
      `  Time: ${ctx.hour}:00 (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][ctx.dayOfWeek]})`,
      `  Idle: ${ctx.idleSeconds}s`,
      `  Meeting active: ${ctx.isMeetingActive ? 'Yes' : 'No'}`,
      `  App switch rate: ${uniqueApps} unique apps${isHighChurn ? ' (HIGH CHURN)' : ''}`,
      '',
      'Suggestion:',
      `  Task: ${suggestion.suggestedTask}`,
      `  Reasoning: ${suggestion.reasoning}`,
    ].filter(Boolean);

    const stateLines = [
      '',
      'Current DJ state:',
      `  Active task: ${djState.currentTask ?? 'None'}`,
      `  Session duration: ${formatMs(sessionDur)}`,
      `  Tracks played: ${djState.playbackHistory.length}`,
      `  Is transitioning: ${djState.isTransitioning ? 'Yes' : 'No'}`,
    ];

    if (djState.currentParams) {
      stateLines.push(
        `  Current BPM: ${djState.currentParams.targetBPM}`,
        `  Current energy: ${djState.currentParams.energy.toFixed(2)}`,
        `  Current valence: ${djState.currentParams.valence.toFixed(2)}`,
      );
    }

    const deltas = djState.parameterDeltas;
    const hasDeltas =
      deltas.bpmOffset !== 0 ||
      deltas.energyOffset !== 0 ||
      deltas.valenceOffset !== 0 ||
      deltas.instrumentalnessOffset !== 0;
    if (hasDeltas) {
      stateLines.push(
        '',
        'Active adjustments:',
        `  BPM: ${deltas.bpmOffset > 0 ? '+' : ''}${deltas.bpmOffset}`,
        `  Energy: ${deltas.energyOffset > 0 ? '+' : ''}${deltas.energyOffset.toFixed(2)}`,
        `  Valence: ${deltas.valenceOffset > 0 ? '+' : ''}${deltas.valenceOffset.toFixed(2)}`,
        `  Instrumentalness: ${deltas.instrumentalnessOffset > 0 ? '+' : ''}${deltas.instrumentalnessOffset.toFixed(2)}`,
      );
    }

    return {
      content: [{
        type: 'text' as const,
        text: [...contextLines, ...stateLines].join('\n'),
      }],
    };
  },
);

// ── Tool 10: spotify_notifications ──────────────────────────────────

server.tool(
  'spotify_notifications',
  'Configure how the DJ notifies you about decisions (task switches, breaks). Supports macOS native notifications and ntfy.sh for phone push.',
  {
    macos: z.boolean().optional().describe('Enable/disable macOS native notifications (default: true)'),
    ntfy_topic: z.string().optional().describe('ntfy.sh topic name for phone push (e.g. "my-spotify-dj"). Set to empty string to disable.'),
    ntfy_server: z.string().optional().describe('ntfy.sh server URL (default: https://ntfy.sh). Use for self-hosted instances.'),
    test: z.boolean().optional().describe('Send a test notification'),
  },
  async ({ macos, ntfy_topic, ntfy_server, test }) => {
    if (macos !== undefined) notifierConfig.macosNotifications = macos;
    if (ntfy_topic !== undefined) notifierConfig.ntfyTopic = ntfy_topic || null;
    if (ntfy_server !== undefined) notifierConfig.ntfyServer = ntfy_server;

    if (test) {
      await notify(notifierConfig, 'DJ: Test', 'Notifications are working!');
    }

    return {
      content: [{
        type: 'text' as const,
        text: [
          'Notification settings:',
          `  macOS notifications: ${notifierConfig.macosNotifications ? 'ON' : 'OFF'}`,
          `  ntfy.sh: ${notifierConfig.ntfyTopic ? `ON (topic: ${notifierConfig.ntfyTopic}, server: ${notifierConfig.ntfyServer})` : 'OFF'}`,
          test ? '\nTest notification sent!' : '',
        ].filter(Boolean).join('\n'),
      }],
    };
  },
);

// ── Tool 11: spotify_set_wake_time ─────────────────────────────────

server.tool(
  'spotify_set_wake_time',
  'Set your typical wake time to calibrate circadian-based music suggestions. The DJ shifts its energy curve so that "peak focus" music plays during your personal peak cortisol window (~2-5h after wake).',
  {
    hour: z.number().min(0).max(23).describe('Wake hour (0-23, e.g. 7 for 7 AM)'),
    minute: z.number().min(0).max(59).optional().describe('Wake minute (default: 0)'),
  },
  async ({ hour, minute }) => {
    djState = {
      ...djState,
      circadianConfig: { wakeTimeHour: hour, wakeTimeMinute: minute ?? 0 },
    };
    persist();

    return {
      content: [{
        type: 'text' as const,
        text: [
          `Wake time set to ${hour}:${String(minute ?? 0).padStart(2, '0')}.`,
          '',
          'Circadian music schedule (calibrated):',
          `  ${hour}-${(hour + 2) % 24}:00 — Energize (cortisol awakening)`,
          `  ${(hour + 2) % 24}-${(hour + 5) % 24}:00 — Deep Focus (peak cognition)`,
          `  ${(hour + 5) % 24}-${(hour + 7) % 24}:00 — Routine (post-lunch dip)`,
          `  ${(hour + 7) % 24}-${(hour + 10) % 24}:00 — Creative (afternoon)`,
          `  ${(hour + 10) % 24}-${(hour + 13) % 24}:00 — Multitasking (evening)`,
          `  ${(hour + 13) % 24}+ — Wind-down (night)`,
        ].join('\n'),
      }],
    };
  },
);

// ── Tool 12: spotify_autopilot ──────────────────────────────────────

server.tool(
  'spotify_autopilot',
  'Enable or disable autonomous DJ mode. When enabled, the DJ monitors your active macOS app and time of day, and automatically transitions the music to match your current activity. Uses hysteresis to avoid flapping on brief app switches.',
  {
    action: z
      .enum(['start', 'stop', 'status'])
      .describe('Start, stop, or check autopilot status'),
    poll_interval_seconds: z
      .number()
      .optional()
      .describe('How often to check context (default: 60s, min: 30s)'),
    stability_seconds: z
      .number()
      .optional()
      .describe('How long an app must be active before triggering a switch (default: 90s)'),
    min_switch_interval_seconds: z
      .number()
      .optional()
      .describe('Minimum time between auto-switches (default: 300s / 5min)'),
  },
  async ({ action, poll_interval_seconds, stability_seconds, min_switch_interval_seconds }) => {
    if (action === 'start') {
      if (!spotify.isAuthenticated()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Not authenticated. Please run spotify_auth first.',
          }],
          isError: true,
        };
      }

      if (!djState.currentTask) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active DJ session. Start one with spotify_play_for_task first, then enable autopilot.',
          }],
          isError: true,
        };
      }

      if (poll_interval_seconds !== undefined) {
        autopilotState.pollIntervalMs = Math.max(30, poll_interval_seconds) * 1000;
      }
      if (stability_seconds !== undefined) {
        autopilotState.stabilityThresholdMs = Math.max(10, stability_seconds) * 1000;
      }
      if (min_switch_interval_seconds !== undefined) {
        autopilotState.minSwitchIntervalMs = Math.max(60, min_switch_interval_seconds) * 1000;
      }

      startAutopilot();

      return {
        content: [{
          type: 'text' as const,
          text: [
            'Autopilot enabled.',
            '',
            'Configuration:',
            `  Poll interval: ${autopilotState.pollIntervalMs / 1000}s`,
            `  Stability threshold: ${autopilotState.stabilityThresholdMs / 1000}s`,
            `  Min switch interval: ${autopilotState.minSwitchIntervalMs / 1000}s`,
            '',
            `Current task: ${djState.currentTask}`,
            '',
            'The DJ will now monitor your active app and time of day,',
            'automatically transitioning the music when you switch activities.',
          ].join('\n'),
        }],
      };
    }

    if (action === 'stop') {
      stopAutopilot();
      return {
        content: [{
          type: 'text' as const,
          text: `Autopilot disabled. Current task (${djState.currentTask ?? 'none'}) will continue playing.`,
        }],
      };
    }

    // status
    const log = autopilotState.transitionLog;
    const recentTransitions = log.length > 0
      ? log.slice(-5).map((t) => {
          const time = new Date(t.at).toLocaleTimeString();
          const actLabel = t.activityLevel ? ` [${t.activityLevel}]` : '';
          return `  ${time}: ${t.from ?? 'none'} → ${t.to} (${t.app})${actLabel}`;
        }).join('\n')
      : '  No transitions yet.';

    const activityInfo = autopilotState.lastActivity
      ? `Activity: ${autopilotState.lastActivity.level} (${autopilotState.lastActivity.count} msgs in last 10min)`
      : 'Activity: no data yet';

    return {
      content: [{
        type: 'text' as const,
        text: [
          `Autopilot: ${autopilotState.enabled ? 'ENABLED' : 'DISABLED'}`,
          '',
          'Configuration:',
          `  Poll interval: ${autopilotState.pollIntervalMs / 1000}s`,
          `  Stability threshold: ${autopilotState.stabilityThresholdMs / 1000}s`,
          `  Min switch interval: ${autopilotState.minSwitchIntervalMs / 1000}s`,
          '',
          `Current task: ${djState.currentTask ?? 'None'}`,
          activityInfo,
          autopilotState.candidateApp
            ? `Candidate: ${autopilotState.candidateApp} → ${autopilotState.candidateTask} (tracking...)`
            : 'No pending candidate.',
          '',
          'Recent auto-transitions:',
          recentTransitions,
        ].join('\n'),
      }],
    };
  },
);

// ── Start server ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Spotify DJ MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
