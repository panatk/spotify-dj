import { describe, it, expect } from 'vitest';
import { activityAdjustments } from '../activity-tracker.js';

describe('activityAdjustments', () => {
  it('quiet reduces energy and BPM', () => {
    const adj = activityAdjustments('quiet');
    expect(adj.energyOffset).toBeLessThan(0);
    expect(adj.bpmOffset).toBeLessThan(0);
  });

  it('normal has zero offsets', () => {
    const adj = activityAdjustments('normal');
    expect(adj.energyOffset).toBe(0);
    expect(adj.bpmOffset).toBe(0);
  });

  it('high increases energy and BPM', () => {
    const adj = activityAdjustments('high');
    expect(adj.energyOffset).toBeGreaterThan(0);
    expect(adj.bpmOffset).toBeGreaterThan(0);
  });

  it('all levels return a description', () => {
    for (const level of ['quiet', 'normal', 'high'] as const) {
      expect(activityAdjustments(level).description.length).toBeGreaterThan(0);
    }
  });
});
