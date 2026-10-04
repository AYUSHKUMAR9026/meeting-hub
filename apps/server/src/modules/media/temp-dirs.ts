import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** Every job directory starts with this, so the startup sweep only touches our own directories. */
export const JOB_DIR_PREFIX = 'meeting-hub-job-';

/** Host names may contain '-'; keep them out of the separator's way. */
const safeHost = () =>
  hostname()
    .replace(/[^A-Za-z0-9]/g, '_')
    .slice(0, 63) || 'host';

/** `meeting-hub-job-{host}-{pid}-` : who owns a job directory. */
const ownerPrefix = (pid: number) => `${JOB_DIR_PREFIX}${safeHost()}-${pid}-`;

/**
 * Runs `fn` with a fresh private directory under `baseDir` and always removes it afterwards,
 * whether `fn` succeeds, throws or is aborted.
 */
export async function withJobDir<T>(baseDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(join(baseDir, ownerPrefix(process.pid)));
  try {
    return await fn(dir);
  } finally {
    // maxRetries: on Windows a just-killed ffmpeg may hold its output file for a moment.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes job directories a dead worker left behind (its `finally` never ran): those of this host
 * whose process is gone, or that carry this process's own pid (a restarted container reuses pids,
 * and nothing of ours exists yet at startup), plus any older than `olderThanMs` (other hosts
 * sharing the directory). Call it at startup only. Returns how many were removed.
 */
export async function sweepStaleJobDirs(baseDir: string, olderThanMs: number, now = Date.now()) {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return 0;
  }
  const thisHost = `${JOB_DIR_PREFIX}${safeHost()}-`;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(JOB_DIR_PREFIX)) continue;
    const path = join(baseDir, name);
    try {
      let stale = false;
      if (name.startsWith(thisHost)) {
        const pid = Number.parseInt(name.slice(thisHost.length), 10);
        stale = Number.isInteger(pid) && (pid === process.pid || !isAlive(pid));
      }
      if (!stale) {
        const info = await stat(path);
        stale = info.isDirectory() && now - info.mtimeMs > olderThanMs;
      }
      if (stale) {
        await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        removed += 1;
      }
    } catch {
      // Gone already or not ours to remove; either way nothing to do.
    }
  }
  return removed;
}

/** Job directories currently present (tests assert none are left behind). */
export async function listJobDirs(baseDir: string): Promise<string[]> {
  try {
    return (await readdir(baseDir)).filter((n) => n.startsWith(JOB_DIR_PREFIX));
  } catch {
    return [];
  }
}
