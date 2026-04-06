import {
  TaskType,
  AudioParameters,
  SpotifyTrack,
  SpotifyRecommendationParams,
  DJState,
} from './types.js';
import { DEFAULT_GENRE_SEEDS } from './task-profiles.js';
import { SpotifyClient } from './spotify-client.js';
import {
  getRecentTrackIds,
  getPenalisedGenres,
  filterOverplayedArtists,
  isTrackOverexposed,
  shouldInjectSurprise,
  getArcModifier,
} from './state-machine.js';
import { lookupBPMs, filterByBPM, sortByBPMProximity } from './bpm-lookup.js';

// ── Helpers ─────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Build recommendation params ─────────────────────────────────────

export function buildRecommendationParams(
  params: AudioParameters,
  task: TaskType,
  penalisedGenres: string[],
): SpotifyRecommendationParams {
  let genres = [...DEFAULT_GENRE_SEEDS[task]];

  if (penalisedGenres.length > 0) {
    const penalised = new Set(penalisedGenres);
    genres = genres.filter((g) => !penalised.has(g));
  }

  if (genres.length === 0) {
    genres.push(DEFAULT_GENRE_SEEDS[task][0] ?? 'ambient');
  }

  return {
    seed_genres: genres.slice(0, 5),
    target_tempo: params.targetBPM,
    min_tempo: params.minBPM,
    max_tempo: params.maxBPM,
    target_instrumentalness: params.instrumentalness,
    target_energy: params.energy,
    target_valence: params.valence,
    target_mode: params.mode,
    target_acousticness: params.acousticness,
    target_danceability: params.danceability,
    limit: 20,
  };
}

// ── P2: Surprise genre selection ────────────────────────────────────

const SURPRISE_GENRES = [
  'world-music', 'bossa-nova', 'soul', 'r-n-b', 'reggae',
  'blues', 'folk', 'latin', 'afrobeat', 'gospel',
];

function pickSurpriseGenre(task: TaskType): string {
  const taskGenres = new Set(DEFAULT_GENRE_SEEDS[task]);
  const candidates = SURPRISE_GENRES.filter((g) => !taskGenres.has(g));
  return candidates[Math.floor(Math.random() * candidates.length)] ?? 'soul';
}

// ── P0: Familiarity pool ────────────────────────────────────────────

async function getFamiliarTracks(
  client: SpotifyClient,
  recentIds: Set<string>,
  state: DJState,
): Promise<SpotifyTrack[]> {
  const pools: SpotifyTrack[] = [];

  // User's top tracks (most familiar)
  try {
    const top = await client.getTopTracks('medium_term', 50);
    pools.push(...top);
  } catch { /* skip */ }

  // Saved/liked tracks
  try {
    const saved = await client.getSavedTracks(50);
    pools.push(...saved);
  } catch { /* skip */ }

  // User's playlist tracks
  try {
    const playlist = await client.getPlaylistTracks(50);
    pools.push(...playlist);
  } catch { /* skip */ }

  // Deduplicate and filter
  const seen = new Set<string>();
  const unique: SpotifyTrack[] = [];
  for (const t of pools) {
    if (!seen.has(t.id) && !recentIds.has(t.id) && !isTrackOverexposed(state, t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }

  // Sort by least-played first so the user hears variety
  const exposures = state.trackExposures;
  unique.sort((a, b) => (exposures[a.id] ?? 0) - (exposures[b.id] ?? 0));

  // Shuffle within exposure tiers to avoid deterministic ordering
  // Group tracks with same exposure count, shuffle within each group
  const grouped = new Map<number, SpotifyTrack[]>();
  for (const t of unique) {
    const exp = exposures[t.id] ?? 0;
    if (!grouped.has(exp)) grouped.set(exp, []);
    grouped.get(exp)!.push(t);
  }
  const result: SpotifyTrack[] = [];
  for (const [, tracks] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    result.push(...shuffle(tracks));
  }

  return result;
}

// ── Main recommendation function ────────────────────────────────────

export async function getRecommendations(
  client: SpotifyClient,
  state: DJState,
): Promise<{
  tracks: SpotifyTrack[];
  source: 'search' | 'familiar' | 'surprise' | 'fallback';
  parameters: AudioParameters;
}> {
  const task = state.currentTask;
  const params = state.currentParams;

  if (!task || !params) {
    return {
      tracks: [],
      source: 'fallback',
      parameters: params ?? {
        minBPM: 60, maxBPM: 80, targetBPM: 70,
        instrumentalness: 0.9, energy: 0.25, valence: 0.3, mode: 0,
      },
    };
  }

  // P1: Apply session energy arc modifier
  const arc = getArcModifier(state);
  const arcAdjustedParams = {
    ...params,
    energy: Math.max(0, Math.min(1, params.energy * arc.energyMultiplier)),
  };

  const recentIds = getRecentTrackIds(state);
  const penalised = getPenalisedGenres(state);

  // P2: Check if it's time for a surprise track
  if (shouldInjectSurprise(state)) {
    const surpriseGenre = pickSurpriseGenre(task);
    const surpriseParams = buildRecommendationParams(arcAdjustedParams, task, penalised);
    surpriseParams.seed_genres = [surpriseGenre];
    try {
      const surpriseTracks = await client.getRecommendations(surpriseParams);
      const fresh = surpriseTracks.filter((t) => !recentIds.has(t.id));
      if (fresh.length > 0) {
        return { tracks: fresh.slice(0, 3), source: 'surprise', parameters: arcAdjustedParams };
      }
    } catch { /* fall through */ }
  }

  // P0: Get familiar tracks and search-discovered tracks
  const [familiarPool, searchTracks] = await Promise.all([
    getFamiliarTracks(client, recentIds, state),
    (async () => {
      const recParams = buildRecommendationParams(arcAdjustedParams, task, penalised);
      try {
        const tracks = await client.getRecommendations(recParams);
        return tracks.filter((t) => !recentIds.has(t.id));
      } catch {
        return [];
      }
    })(),
  ]);

  // P1: Filter overplayed artists from both pools
  const filteredFamiliar = filterOverplayedArtists(state, familiarPool);
  const filteredSearch = filterOverplayedArtists(state, searchTracks);

  // P0: Mix 70% familiar / 30% discovered
  const familiarCount = Math.ceil(20 * 0.7);
  const searchCount = 20 - familiarCount;

  const mixed: SpotifyTrack[] = [];
  const usedIds = new Set<string>();

  // Add familiar tracks
  for (const t of filteredFamiliar) {
    if (mixed.length >= familiarCount) break;
    if (!usedIds.has(t.id)) {
      usedIds.add(t.id);
      mixed.push(t);
    }
  }

  // Fill with search tracks
  for (const t of filteredSearch) {
    if (mixed.length >= familiarCount + searchCount) break;
    if (!usedIds.has(t.id)) {
      usedIds.add(t.id);
      mixed.push(t);
    }
  }

  // If we got tracks, apply BPM filtering via Deezer
  if (mixed.length > 0) {
    const source = filteredFamiliar.length > 0 ? 'familiar' : 'search';
    try {
      const bpmMap = await lookupBPMs(mixed);
      const bpmFiltered = filterByBPM(mixed, bpmMap, arcAdjustedParams.minBPM, arcAdjustedParams.maxBPM);
      if (bpmFiltered.length > 0) {
        const sorted = sortByBPMProximity(bpmFiltered, bpmMap, arcAdjustedParams.targetBPM);
        return { tracks: sorted, source, parameters: arcAdjustedParams };
      }
      // BPM filter was too strict — fall back to BPM-sorted without filtering
      const sorted = sortByBPMProximity(mixed, bpmMap, arcAdjustedParams.targetBPM);
      return { tracks: sorted, source, parameters: arcAdjustedParams };
    } catch {
      // BPM lookup failed — return shuffled without BPM data
      return { tracks: shuffle(mixed), source, parameters: arcAdjustedParams };
    }
  }

  // Last resort: just use whatever search returned unfiltered
  if (searchTracks.length > 0) {
    return { tracks: shuffle(searchTracks), source: 'search', parameters: arcAdjustedParams };
  }

  return { tracks: [], source: 'fallback', parameters: arcAdjustedParams };
}
