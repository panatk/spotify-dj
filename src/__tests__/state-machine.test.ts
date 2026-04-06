import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInitialState,
  applyDeltas,
  computeTransitionSteps,
  transitionToTask,
  advanceTransition,
  applyAdjustment,
  recordTrack,
  getRecentTrackIds,
  getPenalisedGenres,
  getSessionDuration,
  isArtistOverplayed,
  filterOverplayedArtists,
  isTrackOverexposed,
  shouldInjectSurprise,
  resetSurpriseCounter,
  shouldTakeBreak,
  isBreakOver,
  startBreak,
  endBreak,
  getArcModifier,
  resetDeltas,
} from '../state-machine.js';
import { TASK_PROFILES } from '../task-profiles.js';
import { DJState, AudioParameters, TrackRecord } from '../types.js';

function makeTrackRecord(overrides: Partial<TrackRecord> = {}): TrackRecord {
  return {
    trackId: 'track-1',
    trackName: 'Test Track',
    artist: 'Test Artist',
    artistIds: ['artist-1'],
    playedAt: Date.now(),
    taskType: 'deep-focus',
    wasSkipped: false,
    ...overrides,
  };
}

describe('createInitialState', () => {
  it('returns a blank state with all required fields', () => {
    const state = createInitialState();
    expect(state.currentTask).toBeNull();
    expect(state.currentParams).toBeNull();
    expect(state.playbackHistory).toEqual([]);
    expect(state.breakState.isOnBreak).toBe(false);
    expect(state.artistPlayCounts).toEqual({});
    expect(state.tracksSinceSurprise).toBe(0);
    expect(state.trackExposures).toEqual({});
    expect(state.circadianConfig.wakeTimeHour).toBe(7);
  });
});

describe('applyDeltas', () => {
  it('applies BPM offset to all BPM fields', () => {
    const base: AudioParameters = {
      minBPM: 60, maxBPM: 80, targetBPM: 70,
      instrumentalness: 0.9, energy: 0.25, valence: 0.3, mode: 0,
    };
    const result = applyDeltas(base, {
      bpmOffset: 10, energyOffset: 0, valenceOffset: 0, instrumentalnessOffset: 0,
    });
    expect(result.targetBPM).toBe(80);
    expect(result.minBPM).toBe(70);
    expect(result.maxBPM).toBe(90);
  });

  it('clamps values to valid ranges', () => {
    const base: AudioParameters = {
      minBPM: 60, maxBPM: 80, targetBPM: 70,
      instrumentalness: 0.9, energy: 0.9, valence: 0.9, mode: 1,
    };
    const result = applyDeltas(base, {
      bpmOffset: 0, energyOffset: 0.5, valenceOffset: 0.5, instrumentalnessOffset: 0.5,
    });
    expect(result.energy).toBe(1);
    expect(result.valence).toBe(1);
    expect(result.instrumentalness).toBe(1);
  });
});

describe('computeTransitionSteps', () => {
  it('generates enough steps to keep BPM change <= 10 per step', () => {
    const from: AudioParameters = {
      minBPM: 60, maxBPM: 80, targetBPM: 70,
      instrumentalness: 0.9, energy: 0.25, valence: 0.3, mode: 0,
    };
    const to: AudioParameters = {
      minBPM: 120, maxBPM: 150, targetBPM: 135,
      instrumentalness: 0.3, energy: 0.9, valence: 0.85, mode: 1,
    };
    const steps = computeTransitionSteps(from, to);
    // BPM diff = 65, so need at least 7 steps (ceil(65/10))
    // But minimum is 8, so should be at least 8
    expect(steps.length).toBeGreaterThanOrEqual(8);

    // Verify each step's BPM change is <= 10 from previous
    let prevBPM = from.targetBPM;
    for (const step of steps) {
      expect(Math.abs(step.targetBPM - prevBPM)).toBeLessThanOrEqual(11); // allow rounding
      prevBPM = step.targetBPM;
    }
  });

  it('interpolates energy and valence', () => {
    const from: AudioParameters = {
      minBPM: 60, maxBPM: 80, targetBPM: 70,
      instrumentalness: 0.9, energy: 0.2, valence: 0.3, mode: 0,
    };
    const to: AudioParameters = {
      minBPM: 60, maxBPM: 80, targetBPM: 70,
      instrumentalness: 0.3, energy: 0.8, valence: 0.7, mode: 1,
    };
    const steps = computeTransitionSteps(from, to);
    // First step should be between from and to
    expect(steps[0].energy).toBeGreaterThan(0.2);
    expect(steps[0].energy).toBeLessThan(0.8);
    // Last step should be close to target
    const last = steps[steps.length - 1];
    expect(last.energy).toBeGreaterThan(0.5);
  });
});

describe('transitionToTask', () => {
  it('sets task and params on initial transition', () => {
    const state = createInitialState();
    const result = transitionToTask(state, 'deep-focus');
    expect(result.currentTask).toBe('deep-focus');
    expect(result.currentParams).not.toBeNull();
    expect(result.currentParams!.targetBPM).toBe(TASK_PROFILES['deep-focus'].targetBPM);
    expect(result.isTransitioning).toBe(false);
  });

  it('creates transition queue when switching tasks', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = transitionToTask(state, 'energize');
    expect(state.currentTask).toBe('energize');
    expect(state.previousTask).toBe('deep-focus');
    // Should have transition steps queued
    expect(state.transitionQueue.length).toBeGreaterThan(0);
  });

  it('sets workCycleStartedAt on first transition', () => {
    const state = createInitialState();
    const result = transitionToTask(state, 'deep-focus');
    expect(result.workCycleStartedAt).not.toBeNull();
  });
});

describe('advanceTransition', () => {
  it('pops from transition queue', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = transitionToTask(state, 'energize');
    const queueLen = state.transitionQueue.length;
    state = advanceTransition(state);
    expect(state.transitionQueue.length).toBe(queueLen - 1);
  });

  it('applies final params when queue is empty', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = { ...state, transitionQueue: [], isTransitioning: true };
    state = advanceTransition(state);
    expect(state.isTransitioning).toBe(false);
    expect(state.currentParams!.targetBPM).toBe(TASK_PROFILES['deep-focus'].targetBPM);
  });
});

describe('recordTrack', () => {
  it('adds track to history', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord());
    expect(state.playbackHistory).toHaveLength(1);
    expect(state.currentTrackId).toBe('track-1');
  });

  it('tracks artist play counts', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ artistIds: ['a1', 'a2'] }));
    expect(state.artistPlayCounts['a1']).toBe(1);
    expect(state.artistPlayCounts['a2']).toBe(1);
    state = recordTrack(state, makeTrackRecord({ trackId: 't2', artistIds: ['a1'] }));
    expect(state.artistPlayCounts['a1']).toBe(2);
  });

  it('tracks exposure counts for non-skipped tracks', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ wasSkipped: false }));
    expect(state.trackExposures['track-1']).toBe(1);
  });

  it('does not increment exposure for skipped tracks', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ wasSkipped: true }));
    expect(state.trackExposures['track-1']).toBeUndefined();
  });

  it('increments tracksSinceSurprise', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    expect(state.tracksSinceSurprise).toBe(0);
    state = recordTrack(state, makeTrackRecord());
    expect(state.tracksSinceSurprise).toBe(1);
  });

  it('increments skipped genre counter', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ wasSkipped: true, genre: 'ambient' }));
    expect(state.skippedGenres['ambient']).toBe(1);
  });
});

describe('getRecentTrackIds', () => {
  it('returns IDs of recent tracks', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ trackId: 'a' }));
    state = recordTrack(state, makeTrackRecord({ trackId: 'b' }));
    const ids = getRecentTrackIds(state);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(false);
  });
});

describe('getPenalisedGenres', () => {
  it('returns genres skipped >= 3 times', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    for (let i = 0; i < 3; i++) {
      state = recordTrack(state, makeTrackRecord({
        trackId: `t${i}`, wasSkipped: true, genre: 'ambient',
      }));
    }
    expect(getPenalisedGenres(state)).toContain('ambient');
  });

  it('does not return genres with < 3 skips', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ wasSkipped: true, genre: 'jazz' }));
    expect(getPenalisedGenres(state)).not.toContain('jazz');
  });
});

describe('artist cap', () => {
  it('marks artist as overplayed after 2 tracks', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = recordTrack(state, makeTrackRecord({ trackId: 't1', artistIds: ['a1'] }));
    expect(isArtistOverplayed(state, 'a1')).toBe(false);
    state = recordTrack(state, makeTrackRecord({ trackId: 't2', artistIds: ['a1'] }));
    expect(isArtistOverplayed(state, 'a1')).toBe(true);
  });

  it('filters tracks with overplayed artists', () => {
    let state = createInitialState();
    state.artistPlayCounts = { 'a1': 2 };
    const tracks = [
      { id: 't1', artists: [{ id: 'a1', name: 'X' }], name: 'X', album: 'X', duration_ms: 0, uri: '' },
      { id: 't2', artists: [{ id: 'a2', name: 'Y' }], name: 'Y', album: 'Y', duration_ms: 0, uri: '' },
    ];
    const filtered = filterOverplayedArtists(state, tracks);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('t2');
  });
});

describe('track exposure', () => {
  it('marks track as overexposed after 12 plays', () => {
    let state = createInitialState();
    state.trackExposures = { 'track-1': 12 };
    expect(isTrackOverexposed(state, 'track-1')).toBe(true);
    expect(isTrackOverexposed(state, 'track-2')).toBe(false);
  });
});

describe('surprise injection', () => {
  it('triggers after 5 tracks', () => {
    let state = createInitialState();
    state = { ...state, tracksSinceSurprise: 5 };
    expect(shouldInjectSurprise(state)).toBe(true);
  });

  it('does not trigger before 5 tracks', () => {
    let state = createInitialState();
    state = { ...state, tracksSinceSurprise: 4 };
    expect(shouldInjectSurprise(state)).toBe(false);
  });

  it('resets counter', () => {
    let state = createInitialState();
    state = { ...state, tracksSinceSurprise: 6 };
    state = resetSurpriseCounter(state);
    expect(state.tracksSinceSurprise).toBe(0);
  });
});

describe('break management', () => {
  it('should take break after interval elapsed', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    // Set work cycle to 26 minutes ago (past the 25min default)
    state = { ...state, workCycleStartedAt: Date.now() - 26 * 60 * 1000 };
    expect(shouldTakeBreak(state)).toBe(true);
  });

  it('should not take break too early', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = { ...state, workCycleStartedAt: Date.now() - 10 * 60 * 1000 };
    expect(shouldTakeBreak(state)).toBe(false);
  });

  it('should not double-break', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = { ...state, workCycleStartedAt: Date.now() - 26 * 60 * 1000 };
    state = startBreak(state);
    expect(shouldTakeBreak(state)).toBe(false);
  });

  it('startBreak sets break state', () => {
    let state = createInitialState();
    state = startBreak(state);
    expect(state.breakState.isOnBreak).toBe(true);
    expect(state.breakState.breakStartedAt).not.toBeNull();
    expect(state.breakState.totalBreaksTaken).toBe(1);
  });

  it('isBreakOver returns true after duration', () => {
    let state = createInitialState();
    state = startBreak(state);
    // Simulate break started 3 minutes ago (past 2.5min default)
    state.breakState.breakStartedAt = Date.now() - 3 * 60 * 1000;
    expect(isBreakOver(state)).toBe(true);
  });

  it('endBreak resets break state and work cycle', () => {
    let state = createInitialState();
    state = startBreak(state);
    state = endBreak(state);
    expect(state.breakState.isOnBreak).toBe(false);
    expect(state.workCycleStartedAt).not.toBeNull();
  });
});

describe('session energy arc', () => {
  it('returns ramp phase early in work cycle', () => {
    let state = createInitialState();
    // Work cycle started 5 minutes ago
    state = { ...state, workCycleStartedAt: Date.now() - 5 * 60 * 1000 };
    const arc = getArcModifier(state);
    expect(arc.phase).toBe('ramp');
    expect(arc.energyMultiplier).toBeGreaterThan(0.85);
    expect(arc.energyMultiplier).toBeLessThan(1.0);
  });

  it('returns sustain phase in the middle', () => {
    let state = createInitialState();
    // Ramp=15min, cooldown starts at breakInterval-10min = 25-10 = 15min
    // So sustain is exactly at the boundary — not reachable with default 25min interval.
    // Extend break interval to 40min so sustain window is 15min-30min.
    state = {
      ...state,
      workCycleStartedAt: Date.now() - 20 * 60 * 1000,
      breakState: { ...state.breakState, breakIntervalMs: 40 * 60 * 1000 },
    };
    const arc = getArcModifier(state);
    expect(arc.phase).toBe('sustain');
    expect(arc.energyMultiplier).toBe(1.0);
  });

  it('returns cooldown phase near break time', () => {
    let state = createInitialState();
    // Work cycle started 22 minutes ago (25min break interval - 10min cooldown = 15min start)
    state = { ...state, workCycleStartedAt: Date.now() - 22 * 60 * 1000 };
    const arc = getArcModifier(state);
    expect(arc.phase).toBe('cooldown');
    expect(arc.energyMultiplier).toBeLessThan(1.0);
    expect(arc.energyMultiplier).toBeGreaterThanOrEqual(0.9);
  });
});

describe('applyAdjustment', () => {
  it('accumulates deltas and recomputes params', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    const originalEnergy = state.currentParams!.energy;
    state = applyAdjustment(state, { energyOffset: 0.1 });
    expect(state.parameterDeltas.energyOffset).toBe(0.1);
    expect(state.currentParams!.energy).toBeCloseTo(originalEnergy + 0.1, 5);
  });
});

describe('resetDeltas', () => {
  it('zeroes all deltas and recomputes params', () => {
    let state = createInitialState();
    state = transitionToTask(state, 'deep-focus');
    state = applyAdjustment(state, { bpmOffset: 20, energyOffset: 0.3 });
    state = resetDeltas(state);
    expect(state.parameterDeltas.bpmOffset).toBe(0);
    expect(state.parameterDeltas.energyOffset).toBe(0);
    expect(state.currentParams!.targetBPM).toBe(TASK_PROFILES['deep-focus'].targetBPM);
  });
});
