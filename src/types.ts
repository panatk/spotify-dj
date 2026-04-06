// Core types for the Spotify DJ MCP Server (C3 design)

/**
 * The six fundamental task types, each mapped to distinct audio parameters
 * based on neuroscience research on music and cognitive performance.
 */
export type TaskType =
  | 'deep-focus'
  | 'multitasking'
  | 'creative'
  | 'routine'
  | 'energize'
  | 'wind-down';

/**
 * Audio parameters that define the target acoustic profile for a task.
 * All float values are 0-1 unless otherwise noted; BPM values are beats per minute.
 */
export interface AudioParameters {
  minBPM: number;
  maxBPM: number;
  targetBPM: number;
  instrumentalness: number;
  energy: number;
  valence: number;
  mode: number; // 1 = major, 0 = minor
  acousticness?: number;
  danceability?: number;
}

/**
 * Record of a track that was played during a session.
 */
export interface TrackRecord {
  trackId: string;
  trackName: string;
  artist: string;
  artistIds: string[];
  playedAt: number; // epoch ms
  taskType: TaskType;
  wasSkipped: boolean;
  skipDepth?: number; // 0-1 ratio of how far through the track before skip/completion
  bpm?: number;
  energy?: number;
  genre?: string;
}

/**
 * Break/silence state for ultradian rhythm alignment.
 */
export interface BreakState {
  lastBreakAt: number | null;
  breakIntervalMs: number;    // default 25 min
  breakDurationMs: number;    // default 2.5 min
  isOnBreak: boolean;
  breakStartedAt: number | null;
  totalBreaksTaken: number;
}

/**
 * Session energy arc — shapes energy over a work cycle.
 * Ramp (15min) → Sustain → Cooldown (10min before break).
 */
export type ArcPhase = 'ramp' | 'sustain' | 'cooldown';

/**
 * Circadian configuration — shifts energy curve to user's wake time.
 */
export interface CircadianConfig {
  wakeTimeHour: number;   // 0-23, default 7
  wakeTimeMinute: number; // 0-59, default 0
}

/**
 * Track exposure counts — persisted across sessions for familiarity scheduling.
 */
export type TrackExposures = Record<string, number>;

/**
 * Accumulated user preference deltas applied on top of the base task profile.
 * These allow fine-tuning without changing the underlying profile.
 */
export interface ParameterDelta {
  bpmOffset: number;
  energyOffset: number;
  valenceOffset: number;
  instrumentalnessOffset: number;
}

/**
 * Complete DJ state — the single source of truth for a session.
 */
export interface DJState {
  currentTask: TaskType | null;
  currentParams: AudioParameters | null;
  parameterDeltas: ParameterDelta;
  playbackHistory: TrackRecord[];
  skippedGenres: Record<string, number>; // genre -> skip count
  sessionStartedAt: number | null; // epoch ms
  sessionDurationMs: number;
  lastTransitionAt: number | null;
  transitionQueue: AudioParameters[];
  isTransitioning: boolean;
  currentTrackId: string | null;
  previousTask: TaskType | null;
  // P0: Silence/break management
  breakState: BreakState;
  // P1: Artist repetition tracking — artistId -> count this session
  artistPlayCounts: Record<string, number>;
  // P1: Track count since last surprise injection
  tracksSinceSurprise: number;
  // P1: Session arc — when the current work cycle started (resets after breaks)
  workCycleStartedAt: number | null;
  // P2: Track exposure counts (persisted across sessions)
  trackExposures: TrackExposures;
  // Cross-session recently played (last 100 track IDs, persisted)
  recentlyPlayedIds: string[];
  // P2: Circadian config
  circadianConfig: CircadianConfig;
}

/**
 * Serialisable session data for persistence.
 */
export interface SessionData {
  djState: DJState;
  savedAt: number;
  version: number; // bump to 2 for new fields
}

/**
 * Spotify OAuth tokens.
 */
export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  clientId: string;
  clientSecret: string;
}

/**
 * Simplified Spotify track representation.
 */
export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: string;
  duration_ms: number;
  uri: string;
}

/**
 * Spotify playback state from the Web API.
 */
export interface SpotifyPlaybackState {
  is_playing: boolean;
  progress_ms: number;
  item: SpotifyTrack | null;
  device: {
    id: string;
    name: string;
    type: string;
    volume_percent: number;
  } | null;
  shuffle_state: boolean;
  repeat_state: string;
}

/**
 * Parameters for the Spotify recommendations endpoint.
 */
export interface SpotifyRecommendationParams {
  seed_genres?: string[];
  seed_tracks?: string[];
  seed_artists?: string[];
  target_tempo?: number;
  min_tempo?: number;
  max_tempo?: number;
  target_instrumentalness?: number;
  target_energy?: number;
  target_valence?: number;
  target_mode?: number;
  target_acousticness?: number;
  target_danceability?: number;
  limit?: number;
}

/**
 * macOS context detected via AppleScript / system queries.
 */
export interface MacOSContext {
  activeApp: string;
  hour: number;
  dayOfWeek: number; // 0=Sunday
  isMeetingActive: boolean;
  /** Frontmost window title (for browser URL/content detection) */
  windowTitle: string | null;
  /** System idle time in seconds */
  idleSeconds: number;
}
