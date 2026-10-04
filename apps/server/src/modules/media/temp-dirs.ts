import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Every job directory starts with this, so the startup sweep only touches our own directories. */
export const JOB_DIR_PREFIX = 'meeting-hub-job-';

/**
 * Runs `fn` with a fresh private directory under `baseDir` and always removes it afterwards,
 * whether `fn` succeeds, throws or is aborted.
 */
export async function withJobDir<T>(baseDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(join(baseDir, JOB_DIR_PREFIX));
  try {
    return await fn(dir);
  } finally {
    // maxRetries: on Windows a just-killed ffmpeg may hold its output file for a moment.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Removes job directories older than `olderThanMs`: what a killed worker left behind (its `finally`
 * never ran). Only directories with our prefix are touched; returns how many were removed.
 */
export async function sweepStaleJobDirs(baseDir: string, olderThanMs: number, now = Date.now()) {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(JOB_DIR_PREFIX)) continue;
    const path = join(baseDir, name);
    try {
      const info = await stat(path);
      if (info.isDirectory() && now - info.mtimeMs > olderThanMs) {
        await rm(path, { recursive: true, force: true });
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
