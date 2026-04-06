import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * BPM lookup via Deezer API with local disk cache.
 *
 * Pipeline: Spotify track (artist + title) → Deezer search → Deezer track detail → BPM
 * Cache: ~/.spotify-dj/bpm-cache.json (persisted across sessions)
 *
 * Deezer API is free, no auth required, 50 req/5s rate limit.
 */

const CACHE_FILE = path.join(os.homedir(), '.spotify-dj', 'bpm-cache.json');
const DEEZER_API = 'https://api.deezer.com';

// In-memory cache, loaded from disk on init
let bpmCache: Record<string, number> = {};
let cacheLoaded = false;

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      bpmCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch {
    bpmCache = {};
  }
}

function saveCache(): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(bpmCache), { encoding: 'utf-8', mode: 0o600 });
  } catch { /* non-critical */ }
}

/**
 * Generate a cache key from artist + title.
 */
function cacheKey(artist: string, title: string): string {
  return `${artist.toLowerCase().trim()}:::${title.toLowerCase().trim()}`;
}

/**
 * Look up BPM for a track via Deezer.
 * Returns the BPM or null if not found.
 * Results are cached to disk to avoid repeated API calls.
 */
export async function lookupBPM(
  artist: string,
  title: string,
): Promise<number | null> {
  loadCache();

  const key = cacheKey(artist, title);
  if (key in bpmCache) {
    return bpmCache[key] || null;
  }

  try {
    // Search Deezer for the track
    const query = encodeURIComponent(`${title} ${artist}`);
    const searchResp = await fetch(`${DEEZER_API}/search/track?q=${query}&limit=3`);
    if (!searchResp.ok) return null;

    const searchData = await searchResp.json() as Record<string, unknown>;
    const results = (searchData.data as Array<Record<string, unknown>>) ?? [];
    if (results.length === 0) {
      // Cache miss — store 0 so we don't re-query
      bpmCache[key] = 0;
      saveCache();
      return null;
    }

    // Take the first result and get full track details (which include BPM)
    const deezerId = results[0].id as number;
    const trackResp = await fetch(`${DEEZER_API}/track/${deezerId}`);
    if (!trackResp.ok) return null;

    const trackData = await trackResp.json() as Record<string, unknown>;
    const bpm = trackData.bpm as number | undefined;

    if (bpm && bpm > 0) {
      bpmCache[key] = bpm;
      saveCache();
      return bpm;
    }

    bpmCache[key] = 0;
    saveCache();
    return null;
  } catch {
    return null;
  }
}

/**
 * Look up BPMs for multiple tracks in parallel.
 * Returns a Map of trackId → BPM.
 */
export async function lookupBPMs(
  tracks: Array<{ id: string; name: string; artists: Array<{ name: string }> }>,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // Process in batches of 5 to respect Deezer rate limits (50 req/5s)
  const batchSize = 5;
  for (let i = 0; i < tracks.length; i += batchSize) {
    const batch = tracks.slice(i, i + batchSize);
    const promises = batch.map(async (track) => {
      const artist = track.artists.map((a) => a.name).join(', ');
      const bpm = await lookupBPM(artist, track.name);
      if (bpm !== null) {
        results.set(track.id, bpm);
      }
    });
    await Promise.all(promises);
  }

  return results;
}

/**
 * Filter tracks to only those within a BPM range.
 * Tracks without BPM data are kept (benefit of the doubt).
 */
export function filterByBPM<T extends { id: string }>(
  tracks: T[],
  bpmMap: Map<string, number>,
  minBPM: number,
  maxBPM: number,
): T[] {
  return tracks.filter((t) => {
    const bpm = bpmMap.get(t.id);
    if (bpm === undefined) return true;
    return bpm >= minBPM && bpm <= maxBPM;
  });
}

/**
 * Sort tracks by proximity to target BPM.
 * Tracks without BPM data are placed at the end.
 */
export function sortByBPMProximity<T extends { id: string }>(
  tracks: T[],
  bpmMap: Map<string, number>,
  targetBPM: number,
): T[] {
  return [...tracks].sort((a, b) => {
    const aBPM = bpmMap.get(a.id);
    const bBPM = bpmMap.get(b.id);
    if (aBPM === undefined && bBPM === undefined) return 0;
    if (aBPM === undefined) return 1;
    if (bBPM === undefined) return -1;
    return Math.abs(aBPM - targetBPM) - Math.abs(bBPM - targetBPM);
  });
}

/**
 * Get the cached BPM for a track, or null if not cached.
 */
export function getCachedBPM(artist: string, title: string): number | null {
  loadCache();
  const val = bpmCache[cacheKey(artist, title)];
  return (val && val > 0) ? val : null;
}

/**
 * Get cache stats.
 */
export function getCacheStats(): { totalEntries: number; withBPM: number; misses: number } {
  loadCache();
  const entries = Object.entries(bpmCache);
  const withBPM = entries.filter(([, v]) => v > 0).length;
  return {
    totalEntries: entries.length,
    withBPM,
    misses: entries.length - withBPM,
  };
}
