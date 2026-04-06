import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  TaskType,
  AudioParameters,
  ParameterDelta,
  TrackRecord,
  DJState,
  SessionData,
  BreakState,
  ArcPhase,
} from './types.js';
import { TASK_PROFILES } from './task-profiles.js';

const SESSION_DIR = path.join(os.homedir(), '.spotify-dj');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');
const SESSION_VERSION = 2;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const TRANSITION_STEPS = 8; // P1: smoother transitions (was 3)
const MAX_BPM_STEP = 10;    // P1: max BPM change per transition step
const RECENT_TRACK_LIMIT = 30;
const SKIP_PENALTY_THRESHOLD = 3;
const ARTIST_CAP_PER_SESSION = 2; // P1: max tracks per artist before rotation
const SURPRISE_INTERVAL = 5;      // P2: inject novelty every N tracks
const OVEREXPOSED_THRESHOLD = 12;  // P2: deprioritize after this many plays

// P0: Break/silence defaults
const DEFAULT_BREAK_INTERVAL_MS = 25 * 60 * 1000; // 25 min
const DEFAULT_BREAK_DURATION_MS = 2.5 * 60 * 1000; // 2.5 min

// P1: Session energy arc timing
const ARC_RAMP_MS = 15 * 60 * 1000;     // 15 min ramp
const ARC_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown before break

// ── helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function ensureDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

// ── public API ───────────────────────────────────────────────────────

function createDefaultBreakState(): BreakState {
  return {
    lastBreakAt: null,
    breakIntervalMs: DEFAULT_BREAK_INTERVAL_MS,
    breakDurationMs: DEFAULT_BREAK_DURATION_MS,
    isOnBreak: false,
    breakStartedAt: null,
    totalBreaksTaken: 0,
  };
}

export function createInitialState(): DJState {
  return {
    currentTask: null,
    currentParams: null,
    parameterDeltas: {
      bpmOffset: 0,
      energyOffset: 0,
      valenceOffset: 0,
      instrumentalnessOffset: 0,
    },
    playbackHistory: [],
    skippedGenres: {},
    sessionStartedAt: null,
    sessionDurationMs: 0,
    lastTransitionAt: null,
    transitionQueue: [],
    isTransitioning: false,
    currentTrackId: null,
    previousTask: null,
    breakState: createDefaultBreakState(),
    artistPlayCounts: {},
    tracksSinceSurprise: 0,
    workCycleStartedAt: null,
    trackExposures: {},
    circadianConfig: { wakeTimeHour: 7, wakeTimeMinute: 0 },
  };
}

/**
 * Apply accumulated deltas to a base AudioParameters, clamping to valid ranges.
 */
export function applyDeltas(
  base: AudioParameters,
  deltas: ParameterDelta,
): AudioParameters {
  const targetBPM = clamp(base.targetBPM + deltas.bpmOffset, 30, 220);
  const minBPM = clamp(base.minBPM + deltas.bpmOffset, 30, 220);
  const maxBPM = clamp(base.maxBPM + deltas.bpmOffset, 30, 220);

  return {
    minBPM,
    maxBPM,
    targetBPM,
    instrumentalness: clamp(base.instrumentalness + deltas.instrumentalnessOffset, 0, 1),
    energy: clamp(base.energy + deltas.energyOffset, 0, 1),
    valence: clamp(base.valence + deltas.valenceOffset, 0, 1),
    mode: base.mode,
    acousticness: base.acousticness !== undefined
      ? clamp(base.acousticness, 0, 1)
      : undefined,
    danceability: base.danceability !== undefined
      ? clamp(base.danceability, 0, 1)
      : undefined,
  };
}

/**
 * P1: Compute transition steps with max BPM change per step.
 * Dynamically calculates the number of steps needed so that
 * BPM never changes by more than MAX_BPM_STEP per step.
 */
export function computeTransitionSteps(
  from: AudioParameters,
  to: AudioParameters,
): AudioParameters[] {
  const bpmDiff = Math.abs(to.targetBPM - from.targetBPM);
  const steps = Math.max(TRANSITION_STEPS, Math.ceil(bpmDiff / MAX_BPM_STEP));

  const result: AudioParameters[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 1);
    result.push({
      minBPM: Math.round(lerp(from.minBPM, to.minBPM, t)),
      maxBPM: Math.round(lerp(from.maxBPM, to.maxBPM, t)),
      targetBPM: Math.round(lerp(from.targetBPM, to.targetBPM, t)),
      instrumentalness: lerp(from.instrumentalness, to.instrumentalness, t),
      energy: lerp(from.energy, to.energy, t),
      valence: lerp(from.valence, to.valence, t),
      mode: to.mode,
      acousticness:
        from.acousticness !== undefined && to.acousticness !== undefined
          ? lerp(from.acousticness, to.acousticness, t)
          : to.acousticness,
      danceability:
        from.danceability !== undefined && to.danceability !== undefined
          ? lerp(from.danceability, to.danceability, t)
          : to.danceability,
    });
  }
  return result;
}

/**
 * Transition the DJ to a new task.
 */
export function transitionToTask(state: DJState, task: TaskType): DJState {
  const baseProfile = { ...TASK_PROFILES[task] };
  const targetParams = applyDeltas(baseProfile, state.parameterDeltas);

  let transitionQueue: AudioParameters[] = [];
  let isTransitioning = false;

  if (state.currentParams && state.currentTask && state.currentTask !== task) {
    transitionQueue = computeTransitionSteps(state.currentParams, targetParams);
    isTransitioning = transitionQueue.length > 0;
  }

  const now = Date.now();
  return {
    ...state,
    previousTask: state.currentTask,
    currentTask: task,
    currentParams: isTransitioning
      ? (transitionQueue.shift() ?? targetParams)
      : targetParams,
    transitionQueue,
    isTransitioning: transitionQueue.length > 0,
    sessionStartedAt: state.sessionStartedAt ?? now,
    lastTransitionAt: now,
    workCycleStartedAt: state.workCycleStartedAt ?? now,
  };
}

export function advanceTransition(state: DJState): DJState {
  if (state.transitionQueue.length === 0) {
    const task = state.currentTask;
    if (!task) return { ...state, isTransitioning: false };
    const baseProfile = { ...TASK_PROFILES[task] };
    const finalParams = applyDeltas(baseProfile, state.parameterDeltas);
    return {
      ...state,
      currentParams: finalParams,
      isTransitioning: false,
      transitionQueue: [],
    };
  }

  const nextParams = state.transitionQueue[0];
  const remaining = state.transitionQueue.slice(1);

  return {
    ...state,
    currentParams: nextParams,
    transitionQueue: remaining,
    isTransitioning: remaining.length > 0,
  };
}

export function applyAdjustment(
  state: DJState,
  adjustment: Partial<ParameterDelta>,
): DJState {
  const newDeltas: ParameterDelta = {
    bpmOffset: state.parameterDeltas.bpmOffset + (adjustment.bpmOffset ?? 0),
    energyOffset: state.parameterDeltas.energyOffset + (adjustment.energyOffset ?? 0),
    valenceOffset: state.parameterDeltas.valenceOffset + (adjustment.valenceOffset ?? 0),
    instrumentalnessOffset:
      state.parameterDeltas.instrumentalnessOffset +
      (adjustment.instrumentalnessOffset ?? 0),
  };

  let currentParams = state.currentParams;
  if (state.currentTask) {
    const baseProfile = { ...TASK_PROFILES[state.currentTask] };
    currentParams = applyDeltas(baseProfile, newDeltas);
  }

  return {
    ...state,
    parameterDeltas: newDeltas,
    currentParams,
  };
}

/**
 * Record a played/skipped track in history.
 * Also tracks artist play counts and exposure counts.
 */
export function recordTrack(state: DJState, record: TrackRecord): DJState {
  const playbackHistory = [...state.playbackHistory, record];
  const skippedGenres = { ...state.skippedGenres };

  if (record.wasSkipped && record.genre) {
    skippedGenres[record.genre] = (skippedGenres[record.genre] ?? 0) + 1;
  }

  // P1: Track artist play counts
  const artistPlayCounts = { ...state.artistPlayCounts };
  for (const artistId of record.artistIds) {
    artistPlayCounts[artistId] = (artistPlayCounts[artistId] ?? 0) + 1;
  }

  // P2: Track exposure counts
  const trackExposures = { ...state.trackExposures };
  if (!record.wasSkipped) {
    trackExposures[record.trackId] = (trackExposures[record.trackId] ?? 0) + 1;
  }

  const sessionDurationMs =
    state.sessionStartedAt !== null
      ? Date.now() - state.sessionStartedAt
      : state.sessionDurationMs;

  return {
    ...state,
    playbackHistory,
    skippedGenres,
    artistPlayCounts,
    trackExposures,
    sessionDurationMs,
    currentTrackId: record.trackId,
    tracksSinceSurprise: state.tracksSinceSurprise + 1,
  };
}

export function getRecentTrackIds(state: DJState): Set<string> {
  const recent = state.playbackHistory.slice(-RECENT_TRACK_LIMIT);
  return new Set(recent.map((r) => r.trackId));
}

export function getPenalisedGenres(state: DJState): string[] {
  return Object.entries(state.skippedGenres)
    .filter(([, count]) => count >= SKIP_PENALTY_THRESHOLD)
    .map(([genre]) => genre);
}

export function getSessionDuration(state: DJState): number {
  if (state.sessionStartedAt === null) return state.sessionDurationMs;
  return Date.now() - state.sessionStartedAt;
}

// ── P1: Artist cap check ────────────────────────────────────────────

/**
 * Check if an artist has exceeded the per-session play cap.
 */
export function isArtistOverplayed(state: DJState, artistId: string): boolean {
  return (state.artistPlayCounts[artistId] ?? 0) >= ARTIST_CAP_PER_SESSION;
}

/**
 * Filter tracks that have overplayed artists.
 */
export function filterOverplayedArtists<T extends { artists: Array<{ id: string }> }>(
  state: DJState,
  tracks: T[],
): T[] {
  return tracks.filter((t) =>
    !t.artists.some((a) => isArtistOverplayed(state, a.id)),
  );
}

// ── P2: Exposure check ──────────────────────────────────────────────

export function isTrackOverexposed(state: DJState, trackId: string): boolean {
  return (state.trackExposures[trackId] ?? 0) >= OVEREXPOSED_THRESHOLD;
}

export function shouldInjectSurprise(state: DJState): boolean {
  return state.tracksSinceSurprise >= SURPRISE_INTERVAL;
}

export function resetSurpriseCounter(state: DJState): DJState {
  return { ...state, tracksSinceSurprise: 0 };
}

// ── P0: Break management ────────────────────────────────────────────

/**
 * Check if it's time for a silence break.
 */
export function shouldTakeBreak(state: DJState): boolean {
  if (state.breakState.isOnBreak) return false;
  const cycleStart = state.workCycleStartedAt ?? state.sessionStartedAt;
  if (!cycleStart) return false;
  const elapsed = Date.now() - cycleStart;
  return elapsed >= state.breakState.breakIntervalMs;
}

/**
 * Check if the current break is over.
 */
export function isBreakOver(state: DJState): boolean {
  if (!state.breakState.isOnBreak || !state.breakState.breakStartedAt) return false;
  return Date.now() - state.breakState.breakStartedAt >= state.breakState.breakDurationMs;
}

export function startBreak(state: DJState): DJState {
  const now = Date.now();
  return {
    ...state,
    breakState: {
      ...state.breakState,
      isOnBreak: true,
      breakStartedAt: now,
      lastBreakAt: now,
      totalBreaksTaken: state.breakState.totalBreaksTaken + 1,
    },
  };
}

export function endBreak(state: DJState): DJState {
  return {
    ...state,
    breakState: {
      ...state.breakState,
      isOnBreak: false,
      breakStartedAt: null,
    },
    workCycleStartedAt: Date.now(), // reset work cycle clock
  };
}

// ── P1: Session energy arc ──────────────────────────────────────────

/**
 * Get the current arc phase and an energy multiplier based on
 * position within the work cycle.
 */
export function getArcModifier(state: DJState): {
  phase: ArcPhase;
  energyMultiplier: number;
} {
  const cycleStart = state.workCycleStartedAt;
  if (!cycleStart) return { phase: 'sustain', energyMultiplier: 1.0 };

  const elapsed = Date.now() - cycleStart;
  const breakAt = state.breakState.breakIntervalMs;

  if (elapsed < ARC_RAMP_MS) {
    // Ramp phase: 0.85 → 1.0 over 15 minutes
    const t = elapsed / ARC_RAMP_MS;
    return { phase: 'ramp', energyMultiplier: lerp(0.85, 1.0, t) };
  }

  if (elapsed > breakAt - ARC_COOLDOWN_MS && elapsed < breakAt) {
    // Cooldown phase: 1.0 → 0.9 over last 10 minutes
    const remaining = breakAt - elapsed;
    const t = remaining / ARC_COOLDOWN_MS;
    return { phase: 'cooldown', energyMultiplier: lerp(0.9, 1.0, t) };
  }

  return { phase: 'sustain', energyMultiplier: 1.0 };
}

// ── Persistence ─────────────────────────────────────────────────────

export function saveSession(state: DJState): void {
  ensureDir();
  const data: SessionData = {
    djState: state,
    savedAt: Date.now(),
    version: SESSION_VERSION,
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function loadSession(): DJState | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const data: SessionData = JSON.parse(raw);
    // Accept version 1 or 2, migrate missing fields
    if (data.version !== SESSION_VERSION && data.version !== 1) return null;
    if (Date.now() - data.savedAt > SESSION_MAX_AGE_MS) return null;
    const loaded = data.djState;
    // Migrate v1 → v2: add missing fields
    const defaults = createInitialState();
    return {
      ...defaults,
      ...loaded,
      breakState: loaded.breakState ?? defaults.breakState,
      artistPlayCounts: loaded.artistPlayCounts ?? {},
      tracksSinceSurprise: loaded.tracksSinceSurprise ?? 0,
      workCycleStartedAt: loaded.workCycleStartedAt ?? null,
      trackExposures: loaded.trackExposures ?? {},
      circadianConfig: loaded.circadianConfig ?? defaults.circadianConfig,
    };
  } catch {
    return null;
  }
}

export function resetDeltas(state: DJState): DJState {
  const zeroDeltas: ParameterDelta = {
    bpmOffset: 0,
    energyOffset: 0,
    valenceOffset: 0,
    instrumentalnessOffset: 0,
  };

  let currentParams = state.currentParams;
  if (state.currentTask) {
    const baseProfile = { ...TASK_PROFILES[state.currentTask] };
    currentParams = applyDeltas(baseProfile, zeroDeltas);
  }

  return {
    ...state,
    parameterDeltas: zeroDeltas,
    currentParams,
  };
}
