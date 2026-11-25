import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from './redis';
import { PermanentError, RetryableError } from './errors';

export class ProviderRetryError extends RetryableError {
  constructor(
    readonly retryAfterMs: number,
    readonly quota = true,
    readonly waitingForTracks = false,
  ) {
    super(
      waitingForTracks
        ? 'PARTICIPANT_AUDIO_WAIT'
        : quota
          ? 'FREE_QUOTA_WAIT'
          : 'AI_PROVIDER_UNAVAILABLE',
      waitingForTracks
        ? 'Waiting for participant audio.'
        : quota
          ? 'Waiting for free quota.'
          : 'The AI provider is temporarily unavailable.',
    );
  }
}

export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(1000, ms) : null;
}

/** Never include an upstream body, URL, header or fetch exception in the error. */
export async function providerError(response: Response): Promise<never> {
  const delay = retryAfter(response.headers.get('retry-after'));
  if (response.status === 429) {
    const body: unknown = await response.json().catch(() => null);
    // Inspect for quota classification only. Raw provider messages are discarded.
    const hint = JSON.stringify(body).slice(0, 16000).toLowerCase();
    const daily = /per.?day|daily|\brpd\b|\basd\b/.test(hint);
    const hourly = /per.?hour|hourly|\bash\b/.test(hint);
    throw new ProviderRetryError(delay ?? (daily ? 86400000 : hourly ? 3600000 : 60000));
  }
  await response.body?.cancel().catch(() => {});
  if (response.status >= 500 || response.status === 408)
    throw new ProviderRetryError(delay ?? 5000, false);
  throw new PermanentError(
    response.status === 401 || response.status === 403
      ? 'AI_PROVIDER_AUTH'
      : response.status === 413
        ? 'TRANSCRIPTION_CHUNK_TOO_LARGE'
        : 'AI_PROVIDER_REJECTED',
    response.status === 401 || response.status === 403
      ? 'The AI provider rejected its credentials.'
      : 'The AI provider rejected the media or request.',
  );
}

export interface QuotaBucket {
  name: string;
  capacity: number;
  windowMs: number;
  cost: number;
}
export interface QuotaLimiter {
  reserve(buckets: readonly QuotaBucket[]): Promise<void>;
  available(buckets: readonly QuotaBucket[]): Promise<boolean>;
}

// Weighted rolling token buckets. Tokens return when their reservation ages out.
// Unlike a refilling day bucket, this also bounds every rolling 24-hour window.
// All buckets are checked before any are charged, atomically across workers.
const RESERVE = `
local tm = redis.call('TIME')
local now = tonumber(tm[1])*1000 + math.floor(tonumber(tm[2])/1000)
local wait = 0
for i,key in ipairs(KEYS) do
  local cap = tonumber(ARGV[(i-1)*3+1])
  local window = tonumber(ARGV[(i-1)*3+2])
  local cost = tonumber(ARGV[(i-1)*3+3])
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now-window)
  local rows = redis.call('ZRANGE',key,0,-1,'WITHSCORES')
  local total = 0
  for n=1,#rows,2 do total = total + tonumber(string.match(rows[n],':([%d.]+)$')) end
  local need = total+cost-cap
  if cost > cap then return -1 end
  if need > 0 then
    for n=1,#rows,2 do
      need = need-tonumber(string.match(rows[n],':([%d.]+)$'))
      if need <= 0 then wait = math.max(wait,tonumber(rows[n+1])+window-now+1); break end
    end
  end
end
if wait > 0 then return wait end
if ARGV[#KEYS*3+1] == 'check' then return 0 end
for i,key in ipairs(KEYS) do
  local cost = tonumber(ARGV[(i-1)*3+3])
  redis.call('ZADD',key,now,ARGV[#KEYS*3+1]..':'..cost)
  redis.call('PEXPIRE',key,tonumber(ARGV[(i-1)*3+2])+1000)
end
return 0
`;

export class RedisQuotaLimiter implements QuotaLimiter {
  private readonly namespace: string;
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    provider: string,
    key: string,
  ) {
    this.namespace = `meeting-hub:ai:${provider}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  }
  private async check(buckets: readonly QuotaBucket[], probe: boolean) {
    if (!buckets.length) return 0;
    if (
      buckets.some(
        (b) => !Number.isFinite(b.cost) || b.cost < 0 || b.capacity <= 0 || b.windowMs <= 0,
      )
    )
      throw new Error('Invalid AI quota reservation');
    try {
      return Number(
        await this.redis.eval(
          RESERVE,
          buckets.length,
          ...buckets.map((b) => `${this.namespace}:${b.name}`),
          ...buckets.flatMap((b) => [b.capacity, b.windowMs, b.cost]),
          probe ? 'check' : randomUUID(),
        ),
      );
    } catch {
      // Fail closed: a Redis outage must never bypass the free-tier guard.
      throw new ProviderRetryError(60000);
    }
  }
  async reserve(buckets: readonly QuotaBucket[]) {
    const wait = await this.check(buckets, false);
    if (wait === -1)
      throw new PermanentError(
        'AI_REQUEST_LIMIT',
        'This request exceeds the configured free provider budget.',
      );
    if (wait > 0) throw new ProviderRetryError(wait);
  }
  async available(buckets: readonly QuotaBucket[]) {
    return (await this.check(buckets, true)) === 0;
  }
}

export const speechBuckets = (seconds: number, hour: number, day: number): QuotaBucket[] => [
  { name: 'audio-hour', capacity: hour, windowMs: 3600000, cost: seconds },
  { name: 'audio-day', capacity: day, windowMs: 86400000, cost: seconds },
];
