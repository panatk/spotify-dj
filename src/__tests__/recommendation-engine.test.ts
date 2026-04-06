import { describe, it, expect } from 'vitest';
import { buildRecommendationParams, calculateFamiliarityRatio, getAdaptiveSurpriseInterval } from '../recommendation-engine.js';
import { AudioParameters, TrackRecord } from '../types.js';
import { createInitialState, transitionToTask, recordTrack } from '../state-machine.js';

const deepFocusParams: AudioParameters = {
  minBPM: 60, maxBPM: 80, targetBPM: 70,
  instrumentalness: 0.9, energy: 0.25, valence: 0.3, mode: 0,
  acousticness: 0.5, danceability: 0.15,
};

describe('buildRecommendationParams', () => {
  it('uses default genre seeds for the task', () => {
    const params = buildRecommendationParams(deepFocusParams, 'deep-focus', []);
    expect(params.seed_genres).toBeDefined();
    expect(params.seed_genres!.length).toBeGreaterThan(0);
    expect(params.seed_genres!.length).toBeLessThanOrEqual(5);
  });

  it('removes penalised genres', () => {
    const params = buildRecommendationParams(deepFocusParams, 'deep-focus', ['ambient']);
    expect(params.seed_genres).not.toContain('ambient');
  });

  it('falls back to first default genre if all penalised', () => {
    // Penalise all deep-focus genres
    const allGenres = ['ambient', 'classical', 'piano', 'minimal', 'new age'];
    const params = buildRecommendationParams(deepFocusParams, 'deep-focus', allGenres);
    expect(params.seed_genres).toBeDefined();
    expect(params.seed_genres!.length).toBeGreaterThan(0);
  });

  it('maps audio parameters to recommendation params', () => {
    const params = buildRecommendationParams(deepFocusParams, 'deep-focus', []);
    expect(params.target_tempo).toBe(70);
    expect(params.min_tempo).toBe(60);
    expect(params.max_tempo).toBe(80);
    expect(params.target_energy).toBe(0.25);
    expect(params.target_valence).toBe(0.3);
    expect(params.target_instrumentalness).toBe(0.9);
    expect(params.target_mode).toBe(0);
    expect(params.target_acousticness).toBe(0.5);
    expect(params.target_danceability).toBe(0.15);
  });

  it('sets limit to 20', () => {
    const params = buildRecommendationParams(deepFocusParams, 'deep-focus', []);
    expect(params.limit).toBe(20);
  });

  it('handles different task types', () => {
    const energizeParams: AudioParameters = {
      minBPM: 120, maxBPM: 150, targetBPM: 135,
      instrumentalness: 0.3, energy: 0.9, valence: 0.85, mode: 1,
    };
    const params = buildRecommendationParams(energizeParams, 'energize', []);
    expect(params.target_tempo).toBe(135);
    expect(params.target_energy).toBe(0.9);
    expect(params.seed_genres).toBeDefined();
  });
});

function makeRecord(overrides: Partial<TrackRecord> = {}): TrackRecord {
  return {
    trackId: `t-${Math.random()}`,
    trackName: 'Test',
    artist: 'Test',
    artistIds: ['a1'],
    playedAt: Date.now(),
    taskType: 'deep-focus',
    wasSkipped: false,
    ...overrides,
  };
}

describe('calculateFamiliarityRatio', () => {
  it('deep-focus has higher familiarity than creative', () => {
    const focusState = transitionToTask(createInitialState(), 'deep-focus');
    const creativeState = transitionToTask(createInitialState(), 'creative');
    const focusRatio = calculateFamiliarityRatio(focusState).ratio;
    const creativeRatio = calculateFamiliarityRatio(creativeState).ratio;
    expect(focusRatio).toBeGreaterThan(creativeRatio);
  });

  it('wind-down has highest familiarity', () => {
    const state = transitionToTask(createInitialState(), 'wind-down');
    const { ratio } = calculateFamiliarityRatio(state);
    expect(ratio).toBeGreaterThanOrEqual(0.80);
  });

  it('energize has lowest familiarity', () => {
    const state = transitionToTask(createInitialState(), 'energize');
    const { ratio } = calculateFamiliarityRatio(state);
    expect(ratio).toBeLessThanOrEqual(0.50);
  });

  it('high skip rate increases familiarity', () => {
    let state = transitionToTask(createInitialState(), 'deep-focus');
    const baseRatio = calculateFamiliarityRatio(state).ratio;

    // Add 10 tracks, 5 skipped
    for (let i = 0; i < 10; i++) {
      state = recordTrack(state, makeRecord({ wasSkipped: i % 2 === 0 }));
    }
    const skippyRatio = calculateFamiliarityRatio(state).ratio;
    expect(skippyRatio).toBeGreaterThan(baseRatio);
  });

  it('low skip rate decreases familiarity', () => {
    let state = transitionToTask(createInitialState(), 'deep-focus');

    // Add 10 tracks, none skipped
    for (let i = 0; i < 10; i++) {
      state = recordTrack(state, makeRecord({ wasSkipped: false }));
    }
    const { ratio } = calculateFamiliarityRatio(state);
    // Should be below the base 0.75 for deep-focus
    expect(ratio).toBeLessThan(0.75);
  });

  it('clamps between 0.25 and 0.90', () => {
    let state = transitionToTask(createInitialState(), 'energize');
    // Add tons of non-skipped tracks to push discovery
    for (let i = 0; i < 20; i++) {
      state = recordTrack(state, makeRecord({ wasSkipped: false }));
    }
    // Even with all modifiers pushing down, shouldn't go below 0.25
    const { ratio } = calculateFamiliarityRatio(state);
    expect(ratio).toBeGreaterThanOrEqual(0.25);
  });

  it('returns reasoning string', () => {
    const state = transitionToTask(createInitialState(), 'deep-focus');
    const { reasoning } = calculateFamiliarityRatio(state);
    expect(reasoning).toContain('base');
    expect(reasoning).toContain('deep-focus');
  });
});

describe('getAdaptiveSurpriseInterval', () => {
  it('returns default with insufficient history', () => {
    const state = transitionToTask(createInitialState(), 'deep-focus');
    expect(getAdaptiveSurpriseInterval(state)).toBe(5);
  });

  it('increases interval when skip rate is high', () => {
    let state = transitionToTask(createInitialState(), 'deep-focus');
    for (let i = 0; i < 10; i++) {
      state = recordTrack(state, makeRecord({ wasSkipped: i < 4 }));
    }
    expect(getAdaptiveSurpriseInterval(state)).toBe(8);
  });

  it('decreases interval when skip rate is low', () => {
    let state = transitionToTask(createInitialState(), 'deep-focus');
    for (let i = 0; i < 10; i++) {
      state = recordTrack(state, makeRecord({ wasSkipped: false }));
    }
    expect(getAdaptiveSurpriseInterval(state)).toBe(4);
  });
});
