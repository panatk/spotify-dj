import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  SpotifyTokens,
  SpotifyTrack,
  SpotifyPlaybackState,
  SpotifyRecommendationParams,
} from './types.js';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const REDIRECT_PORT = 8901;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

const CONFIG_DIR = path.join(os.homedir(), '.spotify-dj');
const TOKENS_FILE = path.join(CONFIG_DIR, 'tokens.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-top-read',
  'user-library-read',
].join(' ');

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Spotify Web API client using the native `fetch` API.
 * Handles OAuth2 authorization, token refresh, rate-limiting, and retries.
 */
export class SpotifyClient {
  private tokens: SpotifyTokens | null = null;

  constructor() {
    this.loadSavedTokens();
  }

  // ── Authentication ───────────────────────────────────────────────

  isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  /**
   * Full OAuth2 authorization code flow.
   * 1. Opens the browser to Spotify's auth page (FIX #5: execSync open).
   * 2. Listens on localhost:8901/callback for the redirect.
   * 3. Exchanges the code for tokens and persists them.
   */
  async authorize(clientId: string, clientSecret: string): Promise<string> {
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = `${SPOTIFY_AUTH_URL}?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state,
    }).toString()}`;

    // FIX #5: Auto-open browser before waiting for callback
    try {
      execSync(`open "${authUrl}"`, { timeout: 5000 });
    } catch {
      // If open fails (e.g. not macOS, CI, or no display), user must open manually
      console.error(`Please open this URL in your browser:\n${authUrl}`);
    }

    const code = await this.waitForCallback(state);
    await this.exchangeCode(code, clientId, clientSecret);

    // Persist credentials for future use
    ensureConfigDir();
    fs.writeFileSync(
      CREDENTIALS_FILE,
      JSON.stringify({ clientId, clientSecret }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );

    return 'Successfully authenticated with Spotify!';
  }

  // ── Token management ─────────────────────────────────────────────

  /**
   * Return a valid access token, refreshing if within 60s of expiry.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated. Please run spotify_auth first.');
    }
    if (this.tokens.expiresAt < Date.now() + 60_000) {
      await this.refreshAccessToken();
    }
    return this.tokens.accessToken;
  }

  async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate.');
    }

    const auth = Buffer.from(
      `${this.tokens.clientId}:${this.tokens.clientSecret}`,
    ).toString('base64');

    const resp = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    this.tokens = {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? this.tokens.refreshToken,
      expiresAt: Date.now() + (data.expires_in as number) * 1000,
      clientId: this.tokens.clientId,
      clientSecret: this.tokens.clientSecret,
    };
    this.saveTokens();
  }

  // ── Generic API request ──────────────────────────────────────────

  /**
   * Make an authenticated request to the Spotify Web API.
   * Handles 429 (rate limit), 401 (token refresh + retry), and 204 (return null).
   */
  async apiRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T | null> {
    const token = await this.getAccessToken();
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${SPOTIFY_API_BASE}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string> | undefined),
    };

    const resp = await fetch(url, { ...options, headers });

    // 204 No Content
    if (resp.status === 204) return null;

    // 429 Rate limited — wait and retry (max 3 attempts)
    if (resp.status === 429) {
      const attempt = ((options as any).__retryCount ?? 0) + 1;
      if (attempt > 3) throw new Error('Spotify rate limit: max retries exceeded');
      const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '2', 10);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.apiRequest<T>(endpoint, { ...options, __retryCount: attempt } as any);
    }

    // 401 Unauthorized — refresh token and retry once
    if (resp.status === 401) {
      await this.refreshAccessToken();
      const newToken = await this.getAccessToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryResp = await fetch(url, { ...options, headers });
      if (retryResp.status === 204) return null;
      if (!retryResp.ok) {
        const text = await retryResp.text();
        throw new Error(`Spotify API error ${retryResp.status}: ${text}`);
      }
      const retryContentType = retryResp.headers.get('content-type') ?? '';
      if (!retryContentType.includes('application/json')) {
        return null;
      }
      return (await retryResp.json()) as T;
    }

    if (!resp.ok) {
      const text = await resp.text();
      // Detect "no active device" specifically
      if (resp.status === 404) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error?.reason === 'NO_ACTIVE_DEVICE') {
            throw new Error('No active Spotify device found. Open Spotify on a device and start/resume playback, then try again.');
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('No active Spotify device')) throw e;
        }
      }
      throw new Error(`Spotify API error ${resp.status}: ${text}`);
    }

    // Some endpoints (e.g. queue, play) return non-JSON on success
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return null;
    }

    return (await resp.json()) as T;
  }

  // ── Playback controls ────────────────────────────────────────────

  async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
    const data = await this.apiRequest<Record<string, unknown>>('/me/player');
    if (!data) return null;

    const item = data.item as Record<string, unknown> | null;
    const device = data.device as Record<string, unknown> | null;

    return {
      is_playing: data.is_playing as boolean,
      progress_ms: data.progress_ms as number,
      item: item ? this.mapTrack(item) : null,
      device: device
        ? {
            id: device.id as string,
            name: device.name as string,
            type: device.type as string,
            volume_percent: device.volume_percent as number,
          }
        : null,
      shuffle_state: data.shuffle_state as boolean,
      repeat_state: data.repeat_state as string,
    };
  }

  /**
   * Start or resume playback.
   * FIX #4: Pass all URIs at once to play them as a sequence.
   */
  async play(
    uris?: string[],
    contextUri?: string,
    deviceId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (uris && uris.length > 0) body.uris = uris;
    if (contextUri) body.context_uri = contextUri;

    let endpoint = '/me/player/play';
    if (deviceId) endpoint += `?device_id=${encodeURIComponent(deviceId)}`;

    await this.apiRequest(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    });
  }

  async pause(): Promise<void> {
    await this.apiRequest('/me/player/pause', { method: 'PUT' });
  }

  async setVolume(volumePercent: number): Promise<void> {
    const vol = Math.max(0, Math.min(100, Math.round(volumePercent)));
    await this.apiRequest(`/me/player/volume?volume_percent=${vol}`, {
      method: 'PUT',
    });
  }

  async addToQueue(uri: string): Promise<void> {
    await this.apiRequest(
      `/me/player/queue?uri=${encodeURIComponent(uri)}`,
      { method: 'POST' },
    );
  }

  async skipToNext(): Promise<void> {
    await this.apiRequest('/me/player/next', { method: 'POST' });
  }

  // ── Library / discovery ──────────────────────────────────────────

  async getTopTracks(
    timeRange: 'short_term' | 'medium_term' | 'long_term' = 'medium_term',
    limit: number = 20,
  ): Promise<SpotifyTrack[]> {
    const data = await this.apiRequest<Record<string, unknown>>(
      `/me/top/tracks?time_range=${timeRange}&limit=${limit}`,
    );
    if (!data) return [];
    const items = data.items as Record<string, unknown>[];
    return items.map((item) => this.mapTrack(item));
  }

  async getSavedTracks(limit: number = 50): Promise<SpotifyTrack[]> {
    const data = await this.apiRequest<Record<string, unknown>>(
      `/me/tracks?limit=${limit}`,
    );
    if (!data) return [];
    const items = data.items as Array<Record<string, unknown>>;
    return items.map((item) => {
      const track = item.track as Record<string, unknown>;
      return this.mapTrack(track);
    });
  }

  async getTrackFeatures(
    trackId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.apiRequest<Record<string, unknown>>(
      `/audio-features/${trackId}`,
    );
  }

  async getMultipleTrackFeatures(
    trackIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    if (trackIds.length === 0) return [];
    const ids = trackIds.slice(0, 100).join(',');
    const data = await this.apiRequest<Record<string, unknown>>(
      `/audio-features?ids=${ids}`,
    );
    if (!data) return [];
    const features = data.audio_features as Array<Record<string, unknown> | null>;
    return features.filter((f): f is Record<string, unknown> => f !== null);
  }

  async getRecommendations(
    params: SpotifyRecommendationParams,
  ): Promise<SpotifyTrack[]> {
    // The /recommendations endpoint is deprecated for most apps.
    // Use Search API with genre/mood keywords as a fallback.
    return this.searchForTracks(params);
  }

  /**
   * Search for tracks using genre keywords as a substitute for the
   * deprecated /recommendations endpoint. Searches multiple genre
   * terms with random offsets for variety and deduplicates results.
   */
  async searchForTracks(
    params: SpotifyRecommendationParams,
  ): Promise<SpotifyTrack[]> {
    const genres = params.seed_genres ?? [];
    const allTracks: SpotifyTrack[] = [];
    const seenIds = new Set<string>();
    const SEARCH_LIMIT = 10; // P0: Spotify API max since Feb 2026

    // Random offset (0-150) for variety
    const offset = Math.floor(Math.random() * 150);

    // Search for each genre keyword
    for (const genre of genres.slice(0, 5)) {
      const query = `genre:"${genre}"`;
      try {
        const data = await this.apiRequest<Record<string, unknown>>(
          `/search?q=${encodeURIComponent(query)}&type=track&limit=${SEARCH_LIMIT}&offset=${offset}`,
        );
        if (data) {
          const tracksObj = data.tracks as Record<string, unknown> | undefined;
          const items = (tracksObj?.items as Record<string, unknown>[]) ?? [];
          for (const item of items) {
            const track = this.mapTrack(item);
            if (!seenIds.has(track.id)) {
              seenIds.add(track.id);
              allTracks.push(track);
            }
          }
        }
      } catch {
        // Continue with other genres
      }
    }

    // Fallback: plain keyword search
    if (allTracks.length === 0 && genres.length > 0) {
      for (const genre of genres.slice(0, 3)) {
        try {
          const data = await this.apiRequest<Record<string, unknown>>(
            `/search?q=${encodeURIComponent(genre)}&type=track&limit=${SEARCH_LIMIT}&offset=${offset}`,
          );
          if (data) {
            const tracksObj = data.tracks as Record<string, unknown> | undefined;
            const items = (tracksObj?.items as Record<string, unknown>[]) ?? [];
            for (const item of items) {
              const track = this.mapTrack(item);
              if (!seenIds.has(track.id)) {
                seenIds.add(track.id);
                allTracks.push(track);
              }
            }
          }
        } catch {
          // Continue
        }
      }
    }

    // Shuffle for variety
    for (let i = allTracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allTracks[i], allTracks[j]] = [allTracks[j], allTracks[i]];
    }

    return allTracks.slice(0, params.limit ?? 20);
  }

  // ── P0: Familiarity sources ─────────────────────────────────────

  /**
   * Get tracks from the user's playlists as a familiarity pool.
   */
  async getPlaylistTracks(limit: number = 50): Promise<SpotifyTrack[]> {
    try {
      const playlists = await this.apiRequest<Record<string, unknown>>('/me/playlists?limit=10');
      if (!playlists) return [];
      const items = (playlists.items as Array<Record<string, unknown>>) ?? [];
      const allTracks: SpotifyTrack[] = [];

      for (const pl of items.slice(0, 5)) {
        const href = pl.href as string | undefined;
        if (!href) continue;
        try {
          const plData = await this.apiRequest<Record<string, unknown>>(href);
          if (!plData) continue;
          const tracks = plData.tracks as Record<string, unknown> | undefined;
          const trackItems = (tracks?.items as Array<Record<string, unknown>>) ?? [];
          for (const ti of trackItems) {
            const track = ti.track as Record<string, unknown> | null;
            if (track && track.id) {
              allTracks.push(this.mapTrack(track));
            }
          }
        } catch { /* skip playlist */ }
        if (allTracks.length >= limit) break;
      }

      return allTracks.slice(0, limit);
    } catch {
      return [];
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private loadSavedTokens(): void {
    try {
      if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
        const data = JSON.parse(raw) as SpotifyTokens;
        if (data.accessToken && data.refreshToken && data.clientId) {
          this.tokens = data;
        }
      }
    } catch {
      // Ignore corrupt token file
    }
  }

  private saveTokens(): void {
    if (!this.tokens) return;
    ensureConfigDir();
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(this.tokens, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private waitForCallback(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Authorization timed out after 120 seconds'));
      }, 120_000);

      const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);

        if (parsedUrl.pathname === '/callback') {
          const code = parsedUrl.searchParams.get('code');
          const state = parsedUrl.searchParams.get('state');
          const error = parsedUrl.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              '<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>',
            );
            clearTimeout(timeout);
            server.close();
            reject(new Error(`Authorization failed: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              '<html><body><h1>State Mismatch</h1><p>Please try again.</p></body></html>',
            );
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#191414;color:#1DB954;">
              <div style="text-align:center;">
                <h1>Spotify DJ Connected!</h1>
                <p>You can close this window and return to your terminal.</p>
              </div>
            </body></html>
          `);

          clearTimeout(timeout);
          server.close();
          resolve(code ?? '');
        }
      });

      server.listen(REDIRECT_PORT, '127.0.0.1');
    });
  }

  private async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
  ): Promise<void> {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const resp = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    this.tokens = {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string,
      expiresAt: Date.now() + (data.expires_in as number) * 1000,
      clientId,
      clientSecret,
    };
    this.saveTokens();
  }

  private mapTrack(item: Record<string, unknown>): SpotifyTrack {
    const artists = (item.artists as Array<Record<string, unknown>>) ?? [];
    const album = item.album as Record<string, unknown> | undefined;
    return {
      id: item.id as string,
      name: item.name as string,
      artists: artists.map((a) => ({
        id: a.id as string,
        name: a.name as string,
      })),
      album: album ? (album.name as string) : 'Unknown',
      duration_ms: (item.duration_ms as number) ?? 0,
      uri: item.uri as string,
    };
  }
}
