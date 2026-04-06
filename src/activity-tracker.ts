import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ACTIVITY_FILE = path.join(os.homedir(), '.spotify-dj', 'activity.log');
const WINDOW_MS = 10 * 60 * 1000; // 10-minute sliding window

/**
 * Activity level derived from Claude Code interaction frequency.
 *
 * - quiet:  0-1 prompts in 10min — user is reading, thinking, or AFK
 * - normal: 2-5 prompts in 10min — steady work pace
 * - high:   6+  prompts in 10min — rapid iteration / pair-programming
 */
export type ActivityLevel = 'quiet' | 'normal' | 'high';

export interface ActivitySnapshot {
  level: ActivityLevel;
  count: number;
  windowMinutes: number;
}

/**
 * Read the activity log and count recent pulses within the sliding window.
 */
export function getActivitySnapshot(): ActivitySnapshot {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let count = 0;

  try {
    if (!fs.existsSync(ACTIVITY_FILE)) {
      return { level: 'quiet', count: 0, windowMinutes: 10 };
    }

    const raw = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    // Count timestamps within the window
    for (const line of lines) {
      const ts = parseInt(line.trim(), 10);
      if (!isNaN(ts) && ts >= cutoff) {
        count++;
      }
    }

    // Prune old entries to prevent the file from growing indefinitely
    const recentLines = lines.filter((line) => {
      const ts = parseInt(line.trim(), 10);
      return !isNaN(ts) && ts >= cutoff;
    });
    if (recentLines.length < lines.length) {
      fs.writeFileSync(ACTIVITY_FILE, recentLines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
    }
  } catch {
    // File doesn't exist or is unreadable — treat as quiet
  }

  let level: ActivityLevel;
  if (count <= 1) {
    level = 'quiet';
  } else if (count <= 5) {
    level = 'normal';
  } else {
    level = 'high';
  }

  return { level, count, windowMinutes: 10 };
}

/**
 * Returns energy and BPM offsets based on Claude Code activity rate.
 * These are applied on top of the base task profile during autopilot.
 */
export function activityAdjustments(level: ActivityLevel): {
  energyOffset: number;
  bpmOffset: number;
  description: string;
} {
  switch (level) {
    case 'quiet':
      return {
        energyOffset: -0.05,
        bpmOffset: -5,
        description: 'Low activity — reducing energy for deeper focus.',
      };
    case 'normal':
      return {
        energyOffset: 0,
        bpmOffset: 0,
        description: 'Normal activity — using standard parameters.',
      };
    case 'high':
      return {
        energyOffset: 0.1,
        bpmOffset: 10,
        description: 'High activity — boosting energy to match your pace.',
      };
  }
}
