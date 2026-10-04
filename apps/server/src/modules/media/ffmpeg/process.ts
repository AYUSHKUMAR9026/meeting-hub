import { spawn } from 'node:child_process';

/** How much of stderr to keep for error details (the tail is what explains a failure). */
const STDERR_TAIL_BYTES = 4_096;

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The last few KB of stderr, for internal error details only. */
  stderr: string;
}

export class ProcessTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} timed out after ${timeoutMs}ms and was killed`);
    this.name = 'ProcessTimeoutError';
  }
}

/** The process could not be started at all (binary missing, not executable). */
export class ProcessSpawnError extends Error {
  constructor(
    readonly command: string,
    cause: unknown,
  ) {
    super(`could not start ${command}: ${(cause as Error).message}`, { cause });
    this.name = 'ProcessSpawnError';
  }
}

export interface RunProcessOptions {
  /** Hard limit; the process is SIGKILLed when it is reached. */
  timeoutMs: number;
  /** Aborting kills the process (SIGKILL) and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Receives stdout chunks as they arrive; without it stdout is discarded. */
  onStdout?: (chunk: Buffer) => void;
}

/**
 * Runs a binary with an argument array: no shell, stdin closed, stdout streamed to `onStdout`,
 * stderr tail captured. Never rejects for a non-zero exit (callers interpret `exitCode`); rejects
 * on timeout, abort, or when the process can't be spawned.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      stdio: ['ignore', options.onStdout ? 'pipe' : 'ignore', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    let settled = false;

    const kill = (reason: Error) => {
      failure ??= reason;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => kill(new ProcessTimeoutError(command, options.timeoutMs)),
      options.timeoutMs,
    );
    const onAbort = () => {
      const reason: unknown = options.signal?.reason;
      kill(reason instanceof Error ? reason : new Error('aborted'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    if (options.onStdout) {
      const onStdout = options.onStdout;
      child.stdout!.on('data', (chunk: Buffer) => {
        try {
          onStdout(chunk);
        } catch (err) {
          kill(err as Error);
        }
      });
    }
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_TAIL_BYTES * 2) stderr = stderr.subarray(-STDERR_TAIL_BYTES);
    });
    child.on('error', (err) => finish(() => reject(new ProcessSpawnError(command, err))));
    child.on('close', (exitCode, signal) =>
      finish(() => {
        if (failure) reject(failure);
        else
          resolve({
            exitCode,
            signal,
            stderr: stderr.subarray(-STDERR_TAIL_BYTES).toString('utf8').trim(),
          });
      }),
    );
  });
}
