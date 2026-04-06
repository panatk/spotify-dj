import { execSync } from 'node:child_process';
import { MacOSContext, TaskType } from './types.js';

/**
 * macOS context detection using AppleScript (osascript).
 * Falls back gracefully on non-macOS systems.
 *
 * Detects: active app, window title, idle time, meeting status.
 */

const MEETING_APPS = new Set([
  'zoom.us',
  'Microsoft Teams',
  'Slack',
  'Google Meet',
  'Webex',
  'FaceTime',
  'Discord',
]);

const APP_TASK_MAP: Record<string, TaskType> = {
  // Code editors → deep-focus
  'Code': 'deep-focus',
  'Visual Studio Code': 'deep-focus',
  'Cursor': 'deep-focus',
  'IntelliJ IDEA': 'deep-focus',
  'WebStorm': 'deep-focus',
  'PyCharm': 'deep-focus',
  'Xcode': 'deep-focus',
  'Neovim': 'deep-focus',
  'Terminal': 'deep-focus',
  'iTerm2': 'deep-focus',
  'Warp': 'deep-focus',
  'Alacritty': 'deep-focus',
  'kitty': 'deep-focus',

  // Design tools → creative
  'Figma': 'creative',
  'Sketch': 'creative',
  'Adobe Illustrator': 'creative',
  'Adobe Photoshop': 'creative',
  'Canva': 'creative',
  'Affinity Designer': 'creative',

  // Communication → multitasking
  'Slack': 'multitasking',
  'Microsoft Teams': 'multitasking',
  'Discord': 'multitasking',
  'Messages': 'multitasking',
  'Mail': 'multitasking',
  'Microsoft Outlook': 'multitasking',
  'Gmail': 'multitasking',

  // Browsers — ambiguous, resolved by window title
  'Safari': 'multitasking',
  'Google Chrome': 'multitasking',
  'Firefox': 'multitasking',
  'Arc': 'multitasking',
  'Brave Browser': 'multitasking',

  // Writing → deep-focus
  'Notes': 'deep-focus',
  'Notion': 'deep-focus',
  'Obsidian': 'deep-focus',
  'Bear': 'deep-focus',
  'iA Writer': 'deep-focus',
  'Ulysses': 'deep-focus',
  'Google Docs': 'deep-focus',
  'Microsoft Word': 'deep-focus',
  'Pages': 'deep-focus',

  // Spreadsheets → routine
  'Microsoft Excel': 'routine',
  'Numbers': 'routine',
  'Google Sheets': 'routine',

  // Presentation → creative
  'Keynote': 'creative',
  'Microsoft PowerPoint': 'creative',
  'Google Slides': 'creative',

  // Music/media → wind-down
  'Spotify': 'wind-down',
  'Apple Music': 'wind-down',
  'Music': 'wind-down',
};

const BROWSER_APPS = new Set([
  'Safari', 'Google Chrome', 'Firefox', 'Arc', 'Brave Browser',
]);

// ── Window title → task classification ──────────────────────────────

interface TitlePattern {
  pattern: RegExp;
  task: TaskType;
}

const TITLE_PATTERNS: TitlePattern[] = [
  // Deep focus: coding, docs, writing
  { pattern: /localhost/i, task: 'deep-focus' },
  { pattern: /github\.com/i, task: 'deep-focus' },
  { pattern: /gitlab\.com/i, task: 'deep-focus' },
  { pattern: /stackoverflow\.com/i, task: 'deep-focus' },
  { pattern: /docs\.google\.com\/document/i, task: 'deep-focus' },
  { pattern: /notion\.so/i, task: 'deep-focus' },
  { pattern: /medium\.com/i, task: 'deep-focus' },
  { pattern: /dev\.to/i, task: 'deep-focus' },
  { pattern: /arxiv\.org/i, task: 'deep-focus' },
  { pattern: /wikipedia\.org/i, task: 'deep-focus' },
  { pattern: /\.md\b/i, task: 'deep-focus' },

  // Creative: design, presentations
  { pattern: /figma\.com/i, task: 'creative' },
  { pattern: /canva\.com/i, task: 'creative' },
  { pattern: /docs\.google\.com\/presentation/i, task: 'creative' },
  { pattern: /dribbble\.com/i, task: 'creative' },
  { pattern: /behance\.net/i, task: 'creative' },
  { pattern: /pinterest/i, task: 'creative' },
  { pattern: /miro\.com/i, task: 'creative' },

  // Routine: spreadsheets, admin
  { pattern: /docs\.google\.com\/spreadsheets/i, task: 'routine' },
  { pattern: /airtable\.com/i, task: 'routine' },
  { pattern: /jira/i, task: 'routine' },
  { pattern: /linear\.app/i, task: 'routine' },
  { pattern: /asana\.com/i, task: 'routine' },

  // Wind-down: entertainment, social
  { pattern: /youtube\.com/i, task: 'wind-down' },
  { pattern: /netflix\.com/i, task: 'wind-down' },
  { pattern: /twitch\.tv/i, task: 'wind-down' },
  { pattern: /twitter\.com|x\.com/i, task: 'wind-down' },
  { pattern: /reddit\.com/i, task: 'wind-down' },
  { pattern: /instagram\.com/i, task: 'wind-down' },
  { pattern: /facebook\.com/i, task: 'wind-down' },
  { pattern: /tiktok\.com/i, task: 'wind-down' },
  { pattern: /news\./i, task: 'wind-down' },

  // Multitasking: email, chat, calendar
  { pattern: /mail\.google\.com/i, task: 'multitasking' },
  { pattern: /outlook\./i, task: 'multitasking' },
  { pattern: /slack\.com/i, task: 'multitasking' },
  { pattern: /calendar\.google\.com/i, task: 'multitasking' },
  { pattern: /teams\.microsoft\.com/i, task: 'multitasking' },
];

/**
 * Classify a browser window title into a task type.
 * Returns null if no pattern matches.
 */
export function classifyWindowTitle(title: string): TaskType | null {
  for (const { pattern, task } of TITLE_PATTERNS) {
    if (pattern.test(title)) return task;
  }
  return null;
}

// ── App switch rate tracking ────────────────────────────────────────

const APP_HISTORY_SIZE = 10;
const appHistory: string[] = [];

/**
 * Record the current app and return the switch rate
 * (unique apps in the last N polls).
 */
export function recordAppAndGetSwitchRate(app: string): {
  uniqueApps: number;
  isHighChurn: boolean;
} {
  appHistory.push(app);
  if (appHistory.length > APP_HISTORY_SIZE) {
    appHistory.shift();
  }
  const unique = new Set(appHistory).size;
  return {
    uniqueApps: unique,
    isHighChurn: unique >= 4, // 4+ unique apps in last 10 polls = high churn
  };
}

/**
 * Get the current switch rate without recording.
 */
export function getAppSwitchRate(): { uniqueApps: number; isHighChurn: boolean } {
  const unique = new Set(appHistory).size;
  return { uniqueApps: unique, isHighChurn: unique >= 4 };
}

// ── Idle detection ──────────────────────────────────────────────────

function getIdleSeconds(): number {
  try {
    const raw = execSync(
      'ioreg -c IOHIDSystem | grep HIDIdleTime',
      { timeout: 2000, encoding: 'utf-8' },
    ).trim();
    // Output: |   "HIDIdleTime" = 123456789
    const match = raw.match(/= (\d+)/);
    if (match) {
      // Value is in nanoseconds
      return Math.floor(parseInt(match[1], 10) / 1_000_000_000);
    }
  } catch { /* non-macOS */ }
  return 0;
}

// ── Main context detection ──────────────────────────────────────────

export function detectMacOSContext(): MacOSContext {
  const now = new Date();
  const defaultContext: MacOSContext = {
    activeApp: 'Unknown',
    hour: now.getHours(),
    dayOfWeek: now.getDay(),
    isMeetingActive: false,
    windowTitle: null,
    idleSeconds: 0,
  };

  try {
    // Combined osascript: get app name + window title in one call
    const result = execSync(
      `osascript -e '
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set winTitle to ""
  try
    tell frontApp
      set winTitle to name of front window
    end tell
  end try
  return appName & "|||" & winTitle
end tell'`,
      { timeout: 3000, encoding: 'utf-8' },
    ).trim();

    const parts = result.split('|||');
    const activeApp = parts[0] ?? 'Unknown';
    const windowTitle = parts[1] || null;

    // Meeting detection
    let isMeetingActive = false;
    try {
      const runningApps = execSync(
        'osascript -e \'tell application "System Events" to get name of every application process\'',
        { timeout: 3000, encoding: 'utf-8' },
      ).trim();
      const appList = runningApps.split(', ');
      isMeetingActive = appList.some((app) => MEETING_APPS.has(app.trim()));
    } catch { /* best-effort */ }

    // Idle time
    const idleSeconds = getIdleSeconds();

    return {
      activeApp,
      hour: now.getHours(),
      dayOfWeek: now.getDay(),
      isMeetingActive,
      windowTitle,
      idleSeconds,
    };
  } catch {
    return defaultContext;
  }
}

// ── Task suggestion ─────────────────────────────────────────────────

export function suggestTaskFromContext(
  ctx: MacOSContext,
  wakeHour: number = 7,
): {
  suggestedTask: TaskType;
  reasoning: string;
} {
  // Meeting overrides everything
  if (ctx.isMeetingActive) {
    return {
      suggestedTask: 'multitasking',
      reasoning:
        'A meeting application is active. Multitasking mode provides moderate, non-intrusive background music.',
    };
  }

  // App switch rate: high churn overrides to multitasking
  const switchRate = getAppSwitchRate();
  if (switchRate.isHighChurn) {
    return {
      suggestedTask: 'multitasking',
      reasoning:
        `High app switching detected (${switchRate.uniqueApps} unique apps in recent polls). Multitasking mode matches rapid context-switching.`,
    };
  }

  // Browser: try window title classification first
  if (BROWSER_APPS.has(ctx.activeApp) && ctx.windowTitle) {
    const titleTask = classifyWindowTitle(ctx.windowTitle);
    if (titleTask) {
      return {
        suggestedTask: titleTask,
        reasoning: `Browser on "${truncate(ctx.windowTitle, 60)}" suggests ${titleTask} mode.`,
      };
    }
  }

  // App-based suggestion
  const appTask = APP_TASK_MAP[ctx.activeApp];
  if (appTask) {
    return {
      suggestedTask: appTask,
      reasoning: `Active app "${ctx.activeApp}" suggests ${appTask} mode. ${getAppReasoning(appTask)}`,
    };
  }

  // Time-based fallback (calibrated to wake time)
  const timeTask = suggestFromTime(ctx.hour, wakeHour);
  return {
    suggestedTask: timeTask.task,
    reasoning: `No specific app detected ("${ctx.activeApp}"). ${timeTask.reasoning}`,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function getAppReasoning(task: TaskType): string {
  const reasons: Record<TaskType, string> = {
    'deep-focus':
      'Code editors and writing tools require sustained concentration. Low-tempo instrumental music reduces cognitive load.',
    'multitasking':
      'Communication tools involve frequent context-switching. Moderate-tempo music sustains energy without overwhelming working memory.',
    'creative':
      'Design and presentation tools benefit from moderate-high arousal to activate divergent thinking.',
    'routine':
      'Spreadsheets and data entry are repetitive tasks. Upbeat music combats boredom and maintains attention.',
    'energize':
      'High-energy music boosts motivation and dopamine for push-through moments.',
    'wind-down':
      'Media consumption or idle activity — gentle music supports relaxation and recovery.',
  };
  return reasons[task];
}

/**
 * P2: Time-based suggestion calibrated to wake time.
 */
function suggestFromTime(
  hour: number,
  wakeHour: number = 7,
): { task: TaskType; reasoning: string } {
  const hoursSinceWake = (hour - wakeHour + 24) % 24;

  if (hoursSinceWake < 2) {
    return {
      task: 'energize',
      reasoning: `Early morning (wake+${hoursSinceWake}h): Energize mode supports the cortisol awakening response.`,
    };
  }
  if (hoursSinceWake < 5) {
    return {
      task: 'deep-focus',
      reasoning: `Mid-morning (wake+${hoursSinceWake}h): Peak cortisol window. Deep-focus for complex work.`,
    };
  }
  if (hoursSinceWake < 7) {
    return {
      task: 'routine',
      reasoning: `Post-lunch (wake+${hoursSinceWake}h): Circadian trough. Upbeat routine music counters the dip.`,
    };
  }
  if (hoursSinceWake < 10) {
    return {
      task: 'creative',
      reasoning: `Afternoon (wake+${hoursSinceWake}h): Reduced inhibition enhances creative thinking (Wieth & Zacks, 2011).`,
    };
  }
  if (hoursSinceWake < 13) {
    return {
      task: 'multitasking',
      reasoning: `Evening (wake+${hoursSinceWake}h): Transitional period. Moderate mode for wrapping up.`,
    };
  }
  return {
    task: 'wind-down',
    reasoning: `Night (wake+${hoursSinceWake}h): Wind-down supports circadian alignment.`,
  };
}
