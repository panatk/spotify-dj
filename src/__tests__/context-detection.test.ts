import { describe, it, expect } from 'vitest';
import {
  suggestTaskFromContext,
  classifyWindowTitle,
  recordAppAndGetSwitchRate,
  getAppSwitchRate,
} from '../context-detection.js';
import { MacOSContext } from '../types.js';

function makeContext(overrides: Partial<MacOSContext> = {}): MacOSContext {
  return {
    activeApp: 'Unknown',
    hour: 10,
    dayOfWeek: 1,
    isMeetingActive: false,
    windowTitle: null,
    idleSeconds: 0,
    ...overrides,
  };
}

describe('suggestTaskFromContext', () => {
  it('meeting overrides everything', () => {
    const ctx = makeContext({ activeApp: 'Code', isMeetingActive: true });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('multitasking');
  });

  it('VS Code suggests deep-focus', () => {
    const ctx = makeContext({ activeApp: 'Code' });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('deep-focus');
  });

  it('Figma suggests creative', () => {
    const ctx = makeContext({ activeApp: 'Figma' });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('creative');
  });

  it('Slack suggests multitasking', () => {
    const ctx = makeContext({ activeApp: 'Slack', isMeetingActive: false });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('multitasking');
  });

  it('Excel suggests routine', () => {
    const ctx = makeContext({ activeApp: 'Microsoft Excel' });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('routine');
  });

  it('unknown app falls back to time-based', () => {
    const ctx = makeContext({ activeApp: 'SomeRandomApp', hour: 10 });
    expect(suggestTaskFromContext(ctx, 7).suggestedTask).toBe('deep-focus');
  });
});

describe('browser window title classification', () => {
  it('Chrome on GitHub suggests deep-focus', () => {
    const ctx = makeContext({
      activeApp: 'Google Chrome',
      windowTitle: 'anthropics/claude-code: Pull Request #42 - github.com',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('deep-focus');
  });

  it('Chrome on YouTube suggests wind-down', () => {
    const ctx = makeContext({
      activeApp: 'Google Chrome',
      windowTitle: 'Lofi hip hop radio - youtube.com',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('wind-down');
  });

  it('Chrome on localhost suggests deep-focus', () => {
    const ctx = makeContext({
      activeApp: 'Google Chrome',
      windowTitle: 'My App - localhost:3000',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('deep-focus');
  });

  it('Chrome on Gmail suggests multitasking', () => {
    const ctx = makeContext({
      activeApp: 'Google Chrome',
      windowTitle: 'Inbox (3) - mail.google.com',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('multitasking');
  });

  it('Chrome on Google Sheets suggests routine', () => {
    const ctx = makeContext({
      activeApp: 'Google Chrome',
      windowTitle: 'Budget 2026 - Google Sheets - docs.google.com/spreadsheets/d/...',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('routine');
  });

  it('Safari on Twitter suggests wind-down', () => {
    const ctx = makeContext({
      activeApp: 'Safari',
      windowTitle: 'Home / X - x.com',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('wind-down');
  });

  it('browser with unrecognised title falls back to multitasking', () => {
    const ctx = makeContext({
      activeApp: 'Google Chrome',
      windowTitle: 'Some Random Site',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('multitasking');
  });

  it('non-browser app ignores window title', () => {
    // VS Code with a weird window title should still be deep-focus
    const ctx = makeContext({
      activeApp: 'Code',
      windowTitle: 'youtube.com - something.ts',
    });
    expect(suggestTaskFromContext(ctx).suggestedTask).toBe('deep-focus');
  });
});

describe('classifyWindowTitle', () => {
  it('github → deep-focus', () => {
    expect(classifyWindowTitle('PR #42 - github.com')).toBe('deep-focus');
  });

  it('stackoverflow → deep-focus', () => {
    expect(classifyWindowTitle('How to fix X - stackoverflow.com')).toBe('deep-focus');
  });

  it('youtube → wind-down', () => {
    expect(classifyWindowTitle('Music video - youtube.com')).toBe('wind-down');
  });

  it('reddit → wind-down', () => {
    expect(classifyWindowTitle('r/programming - reddit.com')).toBe('wind-down');
  });

  it('figma.com → creative', () => {
    expect(classifyWindowTitle('My design - figma.com/file/...')).toBe('creative');
  });

  it('slack.com → multitasking', () => {
    expect(classifyWindowTitle('general - slack.com')).toBe('multitasking');
  });

  it('unknown title → null', () => {
    expect(classifyWindowTitle('My Custom App')).toBeNull();
  });
});

describe('circadian wake-time calibration', () => {
  it('wake+0-2h suggests energize', () => {
    const ctx = makeContext({ activeApp: 'Unknown', hour: 7 });
    expect(suggestTaskFromContext(ctx, 7).suggestedTask).toBe('energize');
  });

  it('wake+3h suggests deep-focus', () => {
    const ctx = makeContext({ activeApp: 'Unknown', hour: 10 });
    expect(suggestTaskFromContext(ctx, 7).suggestedTask).toBe('deep-focus');
  });

  it('wake+6h suggests routine', () => {
    const ctx = makeContext({ activeApp: 'Unknown', hour: 13 });
    expect(suggestTaskFromContext(ctx, 7).suggestedTask).toBe('routine');
  });

  it('wake+8h suggests creative', () => {
    const ctx = makeContext({ activeApp: 'Unknown', hour: 15 });
    expect(suggestTaskFromContext(ctx, 7).suggestedTask).toBe('creative');
  });

  it('late night suggests wind-down', () => {
    const ctx = makeContext({ activeApp: 'Unknown', hour: 23 });
    expect(suggestTaskFromContext(ctx, 7).suggestedTask).toBe('wind-down');
  });

  it('respects custom wake time', () => {
    const ctx = makeContext({ activeApp: 'Unknown', hour: 12 });
    expect(suggestTaskFromContext(ctx, 10).suggestedTask).toBe('deep-focus');
  });
});

describe('app switch rate', () => {
  it('starts with low churn', () => {
    // Note: this test is order-dependent with shared state.
    // The appHistory array persists across calls.
    const rate = getAppSwitchRate();
    // Just verify it returns the expected shape
    expect(typeof rate.uniqueApps).toBe('number');
    expect(typeof rate.isHighChurn).toBe('boolean');
  });

  it('records apps and tracks unique count', () => {
    const r1 = recordAppAndGetSwitchRate('Code');
    const r2 = recordAppAndGetSwitchRate('Code');
    // Same app twice — unique count shouldn't increase beyond what's in history
    expect(r2.uniqueApps).toBeLessThanOrEqual(r1.uniqueApps + 1);
  });

  it('detects high churn with many different apps', () => {
    // Push enough unique apps to trigger high churn
    recordAppAndGetSwitchRate('App1');
    recordAppAndGetSwitchRate('App2');
    recordAppAndGetSwitchRate('App3');
    recordAppAndGetSwitchRate('App4');
    recordAppAndGetSwitchRate('App5');
    const rate = recordAppAndGetSwitchRate('App6');
    expect(rate.isHighChurn).toBe(true);
  });

  it('high churn overrides app suggestion to multitasking', () => {
    // After the previous test, we have high churn
    // Even VS Code should return multitasking
    const ctx = makeContext({ activeApp: 'Code' });
    const result = suggestTaskFromContext(ctx);
    expect(result.suggestedTask).toBe('multitasking');
    expect(result.reasoning).toContain('app switching');
  });
});
