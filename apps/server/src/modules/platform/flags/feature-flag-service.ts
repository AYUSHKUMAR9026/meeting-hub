import type { Logger } from '../../../lib/logger';
import { type FlagKey, flagDefinitions, isKnownFlag } from './definitions';

export interface FlagRecord {
  key: string;
  workspaceId: string | null;
  enabled: boolean;
}

/** Where flag rows come from. The DB implementation lives in db-flag-store.ts. */
export interface FlagStore {
  loadAll(): Promise<FlagRecord[]>;
}

export interface FlagContext {
  workspaceId?: string;
}

export type FlagSource = 'override' | 'database' | 'default';

export interface FlagEvaluation {
  key: string;
  enabled: boolean;
  source: FlagSource;
}

export interface FeatureFlagServiceOptions {
  store: FlagStore;
  /** Env overrides (FEATURE_FLAGS_OVERRIDE); always win. */
  overrides?: Readonly<Record<string, boolean>>;
  /** How long a DB snapshot is reused. 0 disables caching. */
  ttlMs: number;
  logger?: Logger;
  now?: () => number;
}

interface Snapshot {
  loadedAt: number;
  global: Map<string, boolean>;
  byWorkspace: Map<string, Map<string, boolean>>;
}

/**
 * Evaluates feature flags. Precedence (highest first):
 *   env override > workspace row > global row (workspace_id NULL) > code default.
 * The whole flag table is cached in memory for `ttlMs`; if a refresh fails the last
 * snapshot is served, and with no snapshot every flag falls back to its default.
 */
export class FeatureFlagService {
  private snapshot: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;
  private readonly overrides: Readonly<Record<string, boolean>>;
  private readonly now: () => number;

  constructor(private readonly options: FeatureFlagServiceOptions) {
    this.overrides = options.overrides ?? {};
    this.now = options.now ?? Date.now;
  }

  async isEnabled(key: FlagKey, context: FlagContext = {}): Promise<boolean> {
    return (await this.evaluate(key, context)).enabled;
  }

  async evaluate(key: string, context: FlagContext = {}): Promise<FlagEvaluation> {
    return this.evaluateWith(await this.getSnapshot(), key, context);
  }

  /** Every flag known to code, the database or overrides, evaluated for `context`. */
  async evaluateAll(context: FlagContext = {}): Promise<FlagEvaluation[]> {
    const snapshot = await this.getSnapshot();
    const keys = new Set<string>([
      ...Object.keys(flagDefinitions),
      ...snapshot.global.keys(),
      ...(context.workspaceId ? (snapshot.byWorkspace.get(context.workspaceId)?.keys() ?? []) : []),
      ...Object.keys(this.overrides),
    ]);
    return [...keys].sort().map((key) => this.evaluateWith(snapshot, key, context));
  }

  /** Drops the cached snapshot so the next evaluation reads the store. */
  invalidate(): void {
    this.snapshot = undefined;
  }

  private evaluateWith(snapshot: Snapshot, key: string, context: FlagContext): FlagEvaluation {
    const override = this.overrides[key];
    if (override !== undefined) return { key, enabled: override, source: 'override' };

    if (context.workspaceId) {
      const scoped = snapshot.byWorkspace.get(context.workspaceId)?.get(key);
      if (scoped !== undefined) return { key, enabled: scoped, source: 'database' };
    }
    const global = snapshot.global.get(key);
    if (global !== undefined) return { key, enabled: global, source: 'database' };

    const enabled = isKnownFlag(key) ? flagDefinitions[key].defaultEnabled : false;
    return { key, enabled, source: 'default' };
  }

  private async getSnapshot(): Promise<Snapshot> {
    const current = this.snapshot;
    if (current && this.now() - current.loadedAt < this.options.ttlMs) return current;

    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<Snapshot> {
    try {
      const rows = await this.options.store.loadAll();
      const snapshot: Snapshot = { loadedAt: this.now(), global: new Map(), byWorkspace: new Map() };
      for (const row of rows) {
        if (row.workspaceId === null) {
          snapshot.global.set(row.key, row.enabled);
        } else {
          let scoped = snapshot.byWorkspace.get(row.workspaceId);
          if (!scoped) snapshot.byWorkspace.set(row.workspaceId, (scoped = new Map<string, boolean>()));
          scoped.set(row.key, row.enabled);
        }
      }
      this.snapshot = snapshot;
      return snapshot;
    } catch (err) {
      if (this.snapshot) {
        this.options.logger?.warn({ err }, 'feature flag refresh failed; serving stale flags');
        return this.snapshot;
      }
      this.options.logger?.error({ err }, 'feature flag load failed; using defaults');
      // Not cached, so the next evaluation retries the store.
      return { loadedAt: 0, global: new Map(), byWorkspace: new Map() };
    }
  }
}
