import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackMonitor, TrackChangeEvent } from '../playback-monitor.js';
import { SpotifyClient } from '../spotify-client.js';

// Create a minimal mock of SpotifyClient
function createMockClient() {
  const client = {
    isAuthenticated: vi.fn().mockReturnValue(true),
    getPlaybackState: vi.fn(),
  } as unknown as SpotifyClient;
  return client;
}

describe('PlaybackMonitor', () => {
  let monitor: PlaybackMonitor;
  let mockClient: SpotifyClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = createMockClient();
    monitor = new PlaybackMonitor(mockClient, 1000); // 1s poll for tests
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it('detects track completion (>85% progress)', async () => {
    const events: TrackChangeEvent[] = [];

    // First poll: track A at 95% progress
    (mockClient.getPlaybackState as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        is_playing: true,
        progress_ms: 190000,
        item: {
          id: 'track-a', name: 'Track A', duration_ms: 200000, uri: 'uri:a',
          artists: [{ id: 'a1', name: 'Artist 1' }], album: 'Album',
        },
        device: null, shuffle_state: false, repeat_state: 'off',
      })
      // Second poll: new track B
      .mockResolvedValueOnce({
        is_playing: true,
        progress_ms: 5000,
        item: {
          id: 'track-b', name: 'Track B', duration_ms: 180000, uri: 'uri:b',
          artists: [{ id: 'a2', name: 'Artist 2' }], album: 'Album',
        },
        device: null, shuffle_state: false, repeat_state: 'off',
      });

    monitor.start((event) => events.push(event));

    // First tick
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(0); // first poll just sets baseline

    // Second tick — track changed
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(1);
    expect(events[0].previousTrackId).toBe('track-a');
    expect(events[0].wasSkipped).toBe(false); // 95% = completed
    expect(events[0].skipDepth).toBeCloseTo(0.95, 1);
  });

  it('detects skip (<85% progress)', async () => {
    const events: TrackChangeEvent[] = [];

    (mockClient.getPlaybackState as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        is_playing: true,
        progress_ms: 30000, // 30s into a 200s track = 15%
        item: {
          id: 'track-a', name: 'Track A', duration_ms: 200000, uri: 'uri:a',
          artists: [{ id: 'a1', name: 'Artist 1' }], album: 'Album',
        },
        device: null, shuffle_state: false, repeat_state: 'off',
      })
      .mockResolvedValueOnce({
        is_playing: true,
        progress_ms: 2000,
        item: {
          id: 'track-b', name: 'Track B', duration_ms: 180000, uri: 'uri:b',
          artists: [{ id: 'a2', name: 'Artist 2' }], album: 'Album',
        },
        device: null, shuffle_state: false, repeat_state: 'off',
      });

    monitor.start((event) => events.push(event));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toHaveLength(1);
    expect(events[0].wasSkipped).toBe(true);
    expect(events[0].skipDepth).toBeCloseTo(0.15, 1);
  });

  it('does not emit event when track stays the same', async () => {
    const events: TrackChangeEvent[] = [];
    const playback = {
      is_playing: true,
      progress_ms: 50000,
      item: {
        id: 'track-a', name: 'Track A', duration_ms: 200000, uri: 'uri:a',
        artists: [{ id: 'a1', name: 'Artist 1' }], album: 'Album',
      },
      device: null, shuffle_state: false, repeat_state: 'off',
    };

    (mockClient.getPlaybackState as ReturnType<typeof vi.fn>)
      .mockResolvedValue(playback);

    monitor.start((event) => events.push(event));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toHaveLength(0);
  });

  it('handles null playback state gracefully', async () => {
    const events: TrackChangeEvent[] = [];

    (mockClient.getPlaybackState as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);

    monitor.start((event) => events.push(event));
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toHaveLength(0);
  });
});
