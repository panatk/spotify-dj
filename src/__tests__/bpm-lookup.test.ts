import { describe, it, expect, vi, afterEach } from 'vitest';
import { filterByBPM, sortByBPMProximity } from '../bpm-lookup.js';

describe('filterByBPM', () => {
  const tracks = [
    { id: 't1', name: 'Slow', artists: [{ name: 'A' }] },
    { id: 't2', name: 'Medium', artists: [{ name: 'B' }] },
    { id: 't3', name: 'Fast', artists: [{ name: 'C' }] },
    { id: 't4', name: 'Unknown', artists: [{ name: 'D' }] },
  ];

  it('filters tracks outside BPM range', () => {
    const bpmMap = new Map([['t1', 55], ['t2', 70], ['t3', 140]]);
    const result = filterByBPM(tracks, bpmMap, 60, 80);
    // t1 (55) is out, t2 (70) is in, t3 (140) is out, t4 (no data) is kept
    expect(result.map((t) => t.id)).toEqual(['t2', 't4']);
  });

  it('keeps tracks without BPM data', () => {
    const bpmMap = new Map<string, number>();
    const result = filterByBPM(tracks, bpmMap, 60, 80);
    expect(result).toHaveLength(4);
  });

  it('handles empty tracks array', () => {
    const result = filterByBPM([], new Map(), 60, 80);
    expect(result).toEqual([]);
  });
});

describe('sortByBPMProximity', () => {
  const tracks = [
    { id: 't1', name: 'Far', artists: [{ name: 'A' }] },
    { id: 't2', name: 'Close', artists: [{ name: 'B' }] },
    { id: 't3', name: 'Exact', artists: [{ name: 'C' }] },
    { id: 't4', name: 'NoBPM', artists: [{ name: 'D' }] },
  ];

  it('sorts by proximity to target BPM', () => {
    const bpmMap = new Map([['t1', 120], ['t2', 72], ['t3', 70]]);
    const sorted = sortByBPMProximity(tracks, bpmMap, 70);
    expect(sorted[0].id).toBe('t3'); // exact match
    expect(sorted[1].id).toBe('t2'); // 2 away
    expect(sorted[2].id).toBe('t1'); // 50 away
    expect(sorted[3].id).toBe('t4'); // no data, at end
  });

  it('places tracks without BPM data at the end', () => {
    const bpmMap = new Map([['t1', 70]]);
    const sorted = sortByBPMProximity(tracks, bpmMap, 70);
    expect(sorted[0].id).toBe('t1');
    // All others at the end (no data)
  });
});
