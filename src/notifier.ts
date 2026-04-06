import { execSync, exec } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_SCRIPT = path.join(__dirname, '..', 'notify.sh');

export interface NotifierConfig {
  /** Enable macOS native notifications (default: true) */
  macosNotifications: boolean;
  /** Optional ntfy.sh topic for phone push notifications */
  ntfyTopic: string | null;
  /** Optional ntfy.sh server URL (default: https://ntfy.sh) */
  ntfyServer: string;
}

export function createDefaultNotifierConfig(): NotifierConfig {
  return {
    macosNotifications: true,
    ntfyTopic: null,
    ntfyServer: 'https://ntfy.sh',
  };
}

/**
 * Send a notification about a DJ decision.
 * Uses macOS native notifications and optionally ntfy.sh for phone push.
 */
export async function notify(
  config: NotifierConfig,
  title: string,
  message: string,
): Promise<void> {
  // macOS notification
  if (config.macosNotifications) {
    try {
      exec('afplay /System/Library/Sounds/Purr.aiff', { timeout: 5000 });
    } catch {
      // Not macOS or sound failed — non-critical
    }
  }

  // ntfy.sh push notification
  if (config.ntfyTopic) {
    try {
      const url = `${config.ntfyServer}/${config.ntfyTopic}`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Title': title,
          'Tags': 'musical_note',
        },
        body: message,
      });
    } catch {
      // Network error — non-critical
    }
  }
}
