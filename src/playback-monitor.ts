import { SpotifyClient } from './spotify-client.js';
import { SpotifyPlaybackState } from './types.js';

/**
 * P1: Polls Spotify playback state to detect skip vs completion.
 * Computes skip depth (progress_ms / duration_ms) when a track changes.
 */

export interface TrackChangeEvent {
  previousTrackId: string;
  previousTrackName: string;
  previousArtist: string;
  previousArtistIds: string[];
  skipDepth: number; // 0-1 ratio — how far through the track
  wasSkipped: boolean; // skipDepth < 0.85
  newTrackId: string | null;
}

export class PlaybackMonitor {
  private client: SpotifyClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTrackId: string | null = null;
  private lastProgressMs: number = 0;
  private lastDurationMs: number = 0;
  private lastTrackName: string = '';
  private lastArtist: string = '';
  private lastArtistIds: string[] = [];
  private onTrackChange: ((event: TrackChangeEvent) => void) | null = null;
  private pollIntervalMs: number;

  constructor(client: SpotifyClient, pollIntervalMs: number = 15000) {
    this.client = client;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(onTrackChange: (event: TrackChangeEvent) => void): void {
    this.onTrackChange = onTrackChange;
    this.stop();
    this.timer = setInterval(() => {
      this.poll().catch((e) =>
        console.error('[playback-monitor] poll error:', e),
      );
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.client.isAuthenticated()) return;

    let playback: SpotifyPlaybackState | null;
    try {
      playback = await this.client.getPlaybackState();
    } catch {
      return;
    }
    if (!playback || !playback.item) return;

    const currentTrackId = playback.item.id;
    const currentProgressMs = playback.progress_ms;

    // Track changed — compute skip depth from previous track
    if (this.lastTrackId && currentTrackId !== this.lastTrackId) {
      const skipDepth = this.lastDurationMs > 0
        ? this.lastProgressMs / this.lastDurationMs
        : 1;

      const event: TrackChangeEvent = {
        previousTrackId: this.lastTrackId,
        previousTrackName: this.lastTrackName,
        previousArtist: this.lastArtist,
        previousArtistIds: this.lastArtistIds,
        skipDepth: Math.min(1, skipDepth),
        wasSkipped: skipDepth < 0.85,
        newTrackId: currentTrackId,
      };

      this.onTrackChange?.(event);
    }

    // Update tracking state
    this.lastTrackId = currentTrackId;
    this.lastProgressMs = currentProgressMs;
    this.lastDurationMs = playback.item.duration_ms;
    this.lastTrackName = playback.item.name;
    this.lastArtist = playback.item.artists.map((a) => a.name).join(', ');
    this.lastArtistIds = playback.item.artists.map((a) => a.id);
  }
}
