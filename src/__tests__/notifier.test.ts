import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDefaultNotifierConfig, notify } from '../notifier.js';

describe('createDefaultNotifierConfig', () => {
  it('has macOS enabled and ntfy disabled by default', () => {
    const config = createDefaultNotifierConfig();
    expect(config.macosNotifications).toBe(true);
    expect(config.ntfyTopic).toBeNull();
    expect(config.ntfyServer).toBe('https://ntfy.sh');
  });
});

describe('notify', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when macOS notifications fail', async () => {
    const config = createDefaultNotifierConfig();
    // This will fail if not on macOS or in CI — should not throw
    await expect(notify(config, 'Test', 'Hello')).resolves.toBeUndefined();
  });

  it('does not throw when everything is disabled', async () => {
    const config = createDefaultNotifierConfig();
    config.macosNotifications = false;
    config.ntfyTopic = null;
    await expect(notify(config, 'Test', 'Hello')).resolves.toBeUndefined();
  });

  it('attempts ntfy.sh POST when topic is set', async () => {
    const config = createDefaultNotifierConfig();
    config.macosNotifications = false;
    config.ntfyTopic = 'test-topic';

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await notify(config, 'Title', 'Body');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe('https://ntfy.sh/test-topic');
  });

  it('uses custom ntfy server', async () => {
    const config = createDefaultNotifierConfig();
    config.macosNotifications = false;
    config.ntfyTopic = 'my-topic';
    config.ntfyServer = 'https://ntfy.example.com';

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await notify(config, 'Title', 'Body');

    expect(mockFetch.mock.calls[0][0]).toBe('https://ntfy.example.com/my-topic');
  });

  it('does not throw when ntfy.sh fetch fails', async () => {
    const config = createDefaultNotifierConfig();
    config.macosNotifications = false;
    config.ntfyTopic = 'test';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    await expect(notify(config, 'Title', 'Body')).resolves.toBeUndefined();
  });
});
