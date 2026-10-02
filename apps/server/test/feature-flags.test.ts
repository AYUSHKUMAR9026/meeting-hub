import { describe, expect, it, vi } from 'vitest';

import { FeatureFlagService, type FlagRecord, type FlagStore } from '../src/modules/platform';

const WS = '0199a000-0000-7000-8000-000000000001';

function storeWith(rows: FlagRecord[]) {
  const loadAll = vi.fn<FlagStore['loadAll']>().mockResolvedValue(rows);
  return { store: { loadAll }, loadAll };
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('FeatureFlagService', () => {
  it('falls back to the code default for known flags and false for unknown ones', async () => {
    const { store } = storeWith([]);
    const flags = new FeatureFlagService({ store, ttlMs: 1000 });
    expect(await flags.evaluate('platform.heartbeat')).toEqual({
      key: 'platform.heartbeat',
      enabled: true,
      source: 'default',
    });
    expect(await flags.evaluate('does.not.exist')).toMatchObject({
      enabled: false,
      source: 'default',
    });
  });

  it('applies precedence: override > workspace row > global row > default', async () => {
    const { store } = storeWith([
      { key: 'x', workspaceId: null, enabled: true },
      { key: 'x', workspaceId: WS, enabled: false },
      { key: 'y', workspaceId: null, enabled: false },
    ]);
    const flags = new FeatureFlagService({ store, ttlMs: 1000, overrides: { y: true } });

    expect(await flags.evaluate('x')).toMatchObject({ enabled: true, source: 'database' });
    expect(await flags.evaluate('x', { workspaceId: WS })).toMatchObject({
      enabled: false,
      source: 'database',
    });
    expect(await flags.evaluate('y', { workspaceId: WS })).toMatchObject({
      enabled: true,
      source: 'override',
    });
  });

  it('caches the store snapshot for ttlMs', async () => {
    const { store, loadAll } = storeWith([{ key: 'x', workspaceId: null, enabled: true }]);
    const time = clock();
    const flags = new FeatureFlagService({ store, ttlMs: 5000, now: time.now });

    await flags.evaluate('x');
    await flags.evaluate('x');
    time.advance(4999);
    await flags.evaluate('x');
    expect(loadAll).toHaveBeenCalledTimes(1);

    time.advance(1);
    await flags.evaluate('x');
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes', async () => {
    const { store, loadAll } = storeWith([]);
    const flags = new FeatureFlagService({ store, ttlMs: 5000 });
    await Promise.all([flags.evaluate('a'), flags.evaluate('b'), flags.evaluate('c')]);
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a reload', async () => {
    const { store, loadAll } = storeWith([]);
    const flags = new FeatureFlagService({ store, ttlMs: 60_000 });
    await flags.evaluate('a');
    flags.invalidate();
    await flags.evaluate('a');
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it('serves the stale snapshot when a refresh fails', async () => {
    const { store, loadAll } = storeWith([{ key: 'x', workspaceId: null, enabled: true }]);
    const time = clock();
    const flags = new FeatureFlagService({ store, ttlMs: 1000, now: time.now });
    await flags.evaluate('x');

    loadAll.mockRejectedValueOnce(new Error('db down'));
    time.advance(2000);
    expect(await flags.evaluate('x')).toMatchObject({ enabled: true, source: 'database' });
  });

  it('uses defaults without caching when the first load fails', async () => {
    const { store, loadAll } = storeWith([{ key: 'x', workspaceId: null, enabled: true }]);
    loadAll.mockRejectedValueOnce(new Error('db down'));
    const flags = new FeatureFlagService({ store, ttlMs: 60_000 });

    expect(await flags.evaluate('x')).toMatchObject({ enabled: false, source: 'default' });
    // Next call retries the store instead of caching the failure.
    expect(await flags.evaluate('x')).toMatchObject({ enabled: true, source: 'database' });
  });

  it('evaluateAll lists code, database and override flags, sorted', async () => {
    const { store } = storeWith([
      { key: 'db.only', workspaceId: null, enabled: true },
      { key: 'ws.only', workspaceId: WS, enabled: true },
    ]);
    const flags = new FeatureFlagService({ store, ttlMs: 1000, overrides: { 'env.only': false } });

    expect((await flags.evaluateAll()).map((f) => f.key)).toEqual([
      'db.only',
      'env.only',
      'platform.heartbeat',
    ]);
    expect((await flags.evaluateAll({ workspaceId: WS })).map((f) => f.key)).toContain('ws.only');
  });

  it('isEnabled returns the boolean for typed flag keys', async () => {
    const { store } = storeWith([{ key: 'platform.heartbeat', workspaceId: null, enabled: false }]);
    const flags = new FeatureFlagService({ store, ttlMs: 1000 });
    expect(await flags.isEnabled('platform.heartbeat')).toBe(false);
  });
});
