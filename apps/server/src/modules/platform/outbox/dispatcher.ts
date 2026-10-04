import { and, asc, domainEvents, eq, inArray, isNull, lte, or, sql } from '@meeting-hub/db';

import type { Database, Transaction } from '../../../lib/db';
import type { Logger } from '../../../lib/logger';
import type { FeatureFlagService } from '../flags/feature-flag-service';
import type { FlagKey } from '../flags/definitions';

export interface OutboxEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  attempts: number;
}

/** Work to do once the handler's transaction has committed (e.g. enqueue a job). */
export type AfterCommit = () => Promise<void>;

export interface OutboxHandler {
  /** The event type handled (a stable string). */
  type: string;
  /**
   * Feature flag that must be on for the event's workspace (`payload.workspaceId`). While it's
   * off the event stays unprocessed, so turning the flag on later processes the backlog.
   */
  flag?: FlagKey;
  /**
   * Applies the event's effect inside the dispatcher's transaction; the event is marked processed
   * in the same transaction. Must be idempotent: an event can be delivered again after a crash.
   */
  handle(event: OutboxEvent, tx: Transaction): Promise<AfterCommit | void>;
}

export interface PollResult {
  processed: number;
  /** Left for later: their handler's flag is off. */
  deferred: number;
  failed: number;
}

const MAX_BACKOFF_MS = 3_600_000;
/** Exponential backoff for a failing handler: 2 s, 4 s, 8 s … capped at an hour. */
export const outboxBackoffMs = (attempts: number) =>
  Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 30));

/**
 * The transactional-outbox dispatcher (ADR 0004). Each poll pages through unprocessed, available
 * events of the handled types, claiming each page with FOR UPDATE SKIP LOCKED (several workers may
 * poll). Each event runs in a savepoint and is marked processed in the same transaction as its
 * effect; a failing handler only backs off its own event.
 */
export class OutboxDispatcher {
  private readonly handlers: Map<string, OutboxHandler>;
  private readonly batchSize: number;
  private readonly maxPages: number;

  constructor(
    private readonly deps: {
      db: Database;
      flags: FeatureFlagService;
      logger: Logger;
      handlers: OutboxHandler[];
      batchSize?: number;
      /** Pages per poll; bounds one poll when a large backlog is deferred behind a flag. */
      maxPagesPerPoll?: number;
      now?: () => Date;
    },
  ) {
    this.handlers = new Map(deps.handlers.map((h) => [h.type, h]));
    if (this.handlers.size !== deps.handlers.length) throw new Error('duplicate outbox handler');
    this.batchSize = deps.batchSize ?? 50;
    this.maxPages = deps.maxPagesPerPoll ?? 20;
  }

  async pollOnce(): Promise<PollResult> {
    const total: PollResult = { processed: 0, deferred: 0, failed: 0 };
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const after: { event: OutboxEvent; run: AfterCommit }[] = [];
      const rows = await this.deps.db.transaction(async (tx) => {
        const claimed = await this.claim(tx, cursor);
        for (const row of claimed) {
          const outcome = await this.dispatch(tx, row);
          total[outcome.result] += 1;
          if (outcome.after) after.push({ event: row, run: outcome.after });
        }
        return claimed;
      });
      for (const { event, run } of after) {
        // Committed already; anything lost here is repaired by the owner's sweeper.
        await run().catch((err: unknown) =>
          this.deps.logger.error(
            { err, eventId: event.id, eventType: event.type },
            'outbox after-commit work failed',
          ),
        );
      }
      if (rows.length < this.batchSize) break;
      const last = rows.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return total;
  }

  /** Polls every `intervalMs` until stopped; a poll never overlaps the previous one. */
  start(intervalMs: number): { stop: () => Promise<void> } {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let current: Promise<unknown> = Promise.resolve();
    const tick = () => {
      if (stopped) return;
      current = this.pollOnce()
        .then((r) => {
          if (r.processed || r.failed) this.deps.logger.debug(r, 'outbox poll');
        })
        .catch((err: unknown) => this.deps.logger.error({ err }, 'outbox poll failed'))
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, intervalMs);
        });
    };
    tick();
    return {
      stop: async () => {
        stopped = true;
        clearTimeout(timer);
        await current;
      },
    };
  }

  private async claim(tx: Transaction, cursor: { createdAt: Date; id: string } | null) {
    const now = this.deps.now?.() ?? new Date();
    const rows = await tx
      .select({
        id: domainEvents.id,
        type: domainEvents.type,
        payload: domainEvents.payload,
        createdAt: domainEvents.createdAt,
        attempts: domainEvents.attempts,
      })
      .from(domainEvents)
      .where(
        and(
          isNull(domainEvents.processedAt),
          lte(domainEvents.availableAt, now),
          inArray(domainEvents.type, [...this.handlers.keys()]),
          cursor
            ? or(
                sql`${domainEvents.createdAt} > ${cursor.createdAt}`,
                and(
                  eq(domainEvents.createdAt, cursor.createdAt),
                  sql`${domainEvents.id} > ${cursor.id}`,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(domainEvents.createdAt), asc(domainEvents.id))
      .limit(this.batchSize)
      .for('update', { skipLocked: true });
    return rows;
  }

  private async dispatch(
    tx: Transaction,
    event: OutboxEvent,
  ): Promise<{ result: keyof PollResult; after?: AfterCommit }> {
    const handler = this.handlers.get(event.type)!;
    const log = this.deps.logger.child({ eventId: event.id, eventType: event.type });
    if (handler.flag) {
      const workspaceId =
        typeof event.payload.workspaceId === 'string' ? event.payload.workspaceId : undefined;
      if (!(await this.deps.flags.isEnabled(handler.flag, workspaceId ? { workspaceId } : {}))) {
        return { result: 'deferred' };
      }
    }
    try {
      const after = await tx.transaction(async (savepoint) => {
        const effect = await handler.handle(event, savepoint);
        await savepoint
          .update(domainEvents)
          .set({ processedAt: this.deps.now?.() ?? new Date(), lastError: null })
          .where(eq(domainEvents.id, event.id));
        return effect;
      });
      return after ? { result: 'processed', after } : { result: 'processed' };
    } catch (err) {
      const attempts = event.attempts + 1;
      const now = this.deps.now?.() ?? new Date();
      await tx
        .update(domainEvents)
        .set({
          attempts,
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1_000),
          availableAt: new Date(now.getTime() + outboxBackoffMs(attempts)),
        })
        .where(eq(domainEvents.id, event.id));
      log.error({ err, attempts }, 'outbox handler failed; will retry');
      return { result: 'failed' };
    }
  }
}
