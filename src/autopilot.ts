import { detectMacOSContext, suggestTaskFromContext, recordAppAndGetSwitchRate } from './context-detection.js';
import { getActivitySnapshot, activityAdjustments, ActivityLevel } from './activity-tracker.js';
import { TaskType } from './types.js';

/**
 * Autopilot state — tracks context stability to avoid flapping
 * when the user briefly switches apps.
 */
export interface AutopilotState {
  enabled: boolean;
  pollIntervalMs: number;
  /** Minimum time an app must be active before triggering a switch */
  stabilityThresholdMs: number;
  /** Minimum time between auto-switches to prevent rapid flapping */
  minSwitchIntervalMs: number;
  /** The app that's currently being tracked for stability */
  candidateApp: string | null;
  /** Task suggested by the candidate app */
  candidateTask: TaskType | null;
  /** When the candidate app was first detected */
  candidateDetectedAt: number | null;
  /** When the last auto-switch happened */
  lastAutoSwitchAt: number | null;
  /** Log of recent auto-transitions for reporting */
  transitionLog: Array<{
    from: TaskType | null;
    to: TaskType;
    app: string;
    at: number;
    reasoning: string;
    activityLevel?: ActivityLevel;
  }>;
  /** Latest activity snapshot for reporting */
  lastActivity: { level: ActivityLevel; count: number } | null;
}

export function createAutopilotState(): AutopilotState {
  return {
    enabled: false,
    pollIntervalMs: 60_000,         // check every 60s
    stabilityThresholdMs: 90_000,   // app must be active for 90s
    minSwitchIntervalMs: 300_000,   // at least 5min between switches
    candidateApp: null,
    candidateTask: null,
    candidateDetectedAt: null,
    lastAutoSwitchAt: null,
    transitionLog: [],
    lastActivity: null,
  };
}

export interface PollResult {
  shouldSwitch: boolean;
  suggestedTask: TaskType | null;
  activeApp: string;
  reasoning: string;
  /** How long the candidate app has been stable */
  stableForMs: number;
  /** Claude Code activity level */
  activityLevel: ActivityLevel;
  activityCount: number;
  /** Energy/BPM adjustments from activity */
  activityEnergyOffset: number;
  activityBpmOffset: number;
  /** User is idle (no keyboard/mouse for 5+ min) */
  isIdle: boolean;
  idleSeconds: number;
  /** App switch rate */
  uniqueApps: number;
  isHighChurn: boolean;
  /** Browser window context */
  windowTitle: string | null;
}

/**
 * Poll the macOS context and decide whether to switch tasks.
 * Returns a decision object — the caller is responsible for
 * actually performing the switch and queuing tracks.
 */
export function pollContext(
  state: AutopilotState,
  currentTask: TaskType | null,
  wakeHour: number = 7,
): { result: PollResult; newState: AutopilotState } {
  const now = Date.now();
  const ctx = detectMacOSContext();
  const suggestion = suggestTaskFromContext(ctx, wakeHour);
  const suggestedTask = suggestion.suggestedTask;

  // Record app for switch rate tracking
  const switchRate = recordAppAndGetSwitchRate(ctx.activeApp);

  // Idle detection (5 minutes = 300 seconds)
  const isIdle = ctx.idleSeconds >= 300;

  // Read Claude Code activity rate
  const activity = getActivitySnapshot();
  const adjustments = activityAdjustments(activity.level);

  let newState = { ...state };
  newState.lastActivity = { level: activity.level, count: activity.count };

  // Common fields for all return paths
  const commonFields = {
    activityLevel: activity.level,
    activityCount: activity.count,
    activityEnergyOffset: adjustments.energyOffset,
    activityBpmOffset: adjustments.bpmOffset,
    isIdle,
    idleSeconds: ctx.idleSeconds,
    uniqueApps: switchRate.uniqueApps,
    isHighChurn: switchRate.isHighChurn,
    windowTitle: ctx.windowTitle,
  };

  // If idle, signal the caller to pause — don't switch tasks
  if (isIdle) {
    return {
      result: {
        shouldSwitch: false,
        suggestedTask: currentTask,
        activeApp: ctx.activeApp,
        reasoning: `User idle for ${ctx.idleSeconds}s — pausing music.`,
        stableForMs: 0,
        ...commonFields,
      },
      newState,
    };
  }

  // If the suggested task is the same as current, reset candidate tracking
  if (suggestedTask === currentTask) {
    newState.candidateApp = null;
    newState.candidateTask = null;
    newState.candidateDetectedAt = null;
    return {
      result: {
        shouldSwitch: false, suggestedTask, activeApp: ctx.activeApp,
        reasoning: `Already in ${currentTask} mode — no change needed. ${adjustments.description}`,
        stableForMs: 0, ...commonFields,
      },
      newState,
    };
  }

  // New candidate detected
  if (suggestedTask !== newState.candidateTask || ctx.activeApp !== newState.candidateApp) {
    newState.candidateApp = ctx.activeApp;
    newState.candidateTask = suggestedTask;
    newState.candidateDetectedAt = now;
    return {
      result: {
        shouldSwitch: false, suggestedTask, activeApp: ctx.activeApp,
        reasoning: `Detected ${ctx.activeApp} → ${suggestedTask}. Waiting for stability (${Math.round(state.stabilityThresholdMs / 1000)}s).`,
        stableForMs: 0, ...commonFields,
      },
      newState,
    };
  }

  // Same candidate — check if stable long enough
  const stableForMs = now - (newState.candidateDetectedAt ?? now);
  if (stableForMs < state.stabilityThresholdMs) {
    return {
      result: {
        shouldSwitch: false, suggestedTask, activeApp: ctx.activeApp,
        reasoning: `${ctx.activeApp} → ${suggestedTask} (stable for ${Math.round(stableForMs / 1000)}s, need ${Math.round(state.stabilityThresholdMs / 1000)}s).`,
        stableForMs, ...commonFields,
      },
      newState,
    };
  }

  // Check minimum interval between switches
  if (newState.lastAutoSwitchAt !== null) {
    const sinceLast = now - newState.lastAutoSwitchAt;
    if (sinceLast < state.minSwitchIntervalMs) {
      return {
        result: {
          shouldSwitch: false, suggestedTask, activeApp: ctx.activeApp,
          reasoning: `${ctx.activeApp} → ${suggestedTask} is stable, but too soon since last switch (${Math.round(sinceLast / 1000)}s, need ${Math.round(state.minSwitchIntervalMs / 1000)}s).`,
          stableForMs, ...commonFields,
        },
        newState,
      };
    }
  }

  // All checks passed — recommend switching
  newState.lastAutoSwitchAt = now;
  newState.candidateApp = null;
  newState.candidateTask = null;
  newState.candidateDetectedAt = null;
  newState.transitionLog = [
    ...newState.transitionLog.slice(-19), // keep last 20
    {
      from: currentTask,
      to: suggestedTask,
      app: ctx.activeApp,
      at: now,
      reasoning: suggestion.reasoning,
      activityLevel: activity.level,
    },
  ];

  return {
    result: {
      shouldSwitch: true, suggestedTask, activeApp: ctx.activeApp,
      reasoning: `${suggestion.reasoning} ${adjustments.description}`,
      stableForMs, ...commonFields,
    },
    newState,
  };
}
