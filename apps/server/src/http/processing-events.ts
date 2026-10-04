import type { Logger } from '../lib/logger';
import { createSubscriber, type Redis } from '../lib/redis';
import { processingChannel } from '../modules/processing';

type Listener = () => void;

/**
 * Fans "run changed" messages from Redis out to SSE streams (ADR 0004). One subscriber connection
 * per API process, created on first use; one Redis subscription per meeting with open streams.
 */
export class ProcessingEventHub {
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly redisUrl: string,
    private readonly logger: Logger,
  ) {}

  /** Calls `listener` whenever the meeting's run changes. Returns the unsubscribe function. */
  async subscribe(meetingId: string, listener: Listener): Promise<() => Promise<void>> {
    const channel = processingChannel(meetingId);
    const subscriber = this.connection();
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await subscriber.subscribe(channel);
    }
    set.add(listener);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        this.listeners.delete(channel);
        await subscriber
          .unsubscribe(channel)
          .catch((err: unknown) =>
            this.logger.warn({ err }, 'could not unsubscribe from processing events'),
          );
      }
    };
  }

  /** Streams currently open (for tests and diagnostics). */
  get size(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  async close(): Promise<void> {
    this.listeners.clear();
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (subscriber) await subscriber.quit().catch(() => subscriber.disconnect());
  }

  private connection(): Redis {
    if (!this.subscriber) {
      const subscriber = createSubscriber(this.redisUrl, 'meeting-hub-api-events');
      subscriber.on('error', (err) =>
        this.logger.warn({ err }, 'processing events connection error'),
      );
      subscriber.on('message', (channel: string) => {
        for (const listener of this.listeners.get(channel) ?? []) listener();
      });
      this.subscriber = subscriber;
    }
    return this.subscriber;
  }
}
