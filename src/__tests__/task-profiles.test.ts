import { describe, it, expect } from 'vitest';
import { TASK_PROFILES, DEFAULT_GENRE_SEEDS, profileRationale } from '../task-profiles.js';
import { TaskType } from '../types.js';

const ALL_TASKS: TaskType[] = [
  'deep-focus', 'multitasking', 'creative', 'routine', 'energize', 'wind-down',
];

describe('TASK_PROFILES', () => {
  it('has a profile for every task type', () => {
    for (const task of ALL_TASKS) {
      expect(TASK_PROFILES[task]).toBeDefined();
    }
  });

  it('deep-focus BPM range is 60-80 (research-based fix)', () => {
    const df = TASK_PROFILES['deep-focus'];
    expect(df.minBPM).toBe(60);
    expect(df.maxBPM).toBe(80);
    expect(df.targetBPM).toBe(70);
  });

  it('deep-focus uses minor key for reduced emotional salience', () => {
    expect(TASK_PROFILES['deep-focus'].mode).toBe(0);
  });

  it('wind-down uses minor key', () => {
    expect(TASK_PROFILES['wind-down'].mode).toBe(0);
  });

  it('all profiles have valid parameter ranges', () => {
    for (const task of ALL_TASKS) {
      const p = TASK_PROFILES[task];
      expect(p.minBPM).toBeLessThanOrEqual(p.targetBPM);
      expect(p.targetBPM).toBeLessThanOrEqual(p.maxBPM);
      expect(p.energy).toBeGreaterThanOrEqual(0);
      expect(p.energy).toBeLessThanOrEqual(1);
      expect(p.valence).toBeGreaterThanOrEqual(0);
      expect(p.valence).toBeLessThanOrEqual(1);
      expect(p.instrumentalness).toBeGreaterThanOrEqual(0);
      expect(p.instrumentalness).toBeLessThanOrEqual(1);
      expect([0, 1]).toContain(p.mode);
    }
  });

  it('deep-focus has high instrumentalness to avoid linguistic interference', () => {
    expect(TASK_PROFILES['deep-focus'].instrumentalness).toBeGreaterThanOrEqual(0.8);
  });

  it('energize has high energy and valence', () => {
    const e = TASK_PROFILES['energize'];
    expect(e.energy).toBeGreaterThanOrEqual(0.8);
    expect(e.valence).toBeGreaterThanOrEqual(0.8);
  });
});

describe('DEFAULT_GENRE_SEEDS', () => {
  it('has seeds for every task type', () => {
    for (const task of ALL_TASKS) {
      expect(DEFAULT_GENRE_SEEDS[task]).toBeDefined();
      expect(DEFAULT_GENRE_SEEDS[task].length).toBeGreaterThan(0);
    }
  });

  it('each task has at most 5 genre seeds', () => {
    for (const task of ALL_TASKS) {
      expect(DEFAULT_GENRE_SEEDS[task].length).toBeLessThanOrEqual(5);
    }
  });
});

describe('profileRationale', () => {
  it('returns non-empty rationale for every task type', () => {
    for (const task of ALL_TASKS) {
      const rationale = profileRationale(task);
      expect(rationale.length).toBeGreaterThan(50);
    }
  });

  it('deep-focus rationale mentions updated BPM range', () => {
    const r = profileRationale('deep-focus');
    expect(r).toContain('60-80');
  });
});
