import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfigOrExit } from '../src/lib/config';
import { AppError } from '../src/lib/errors';
import { ProviderRetryError, RedisQuotaLimiter } from '../src/lib/ai-quota';
import { createRedis } from '../src/lib/redis';
import { configuredLlm, extractLiveCheck } from '../src/modules/analysis';
import { MediaToolkit, prepareSpeechAudio, withJobDir } from '../src/modules/media';
import { GroqTranscriptionProvider } from '../src/modules/transcription';

const config = loadConfigOrExit();
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const audioArg = args.find((arg) => !arg.startsWith('--'));
if (!audioArg || args.some((arg) => arg.startsWith('--') && arg !== '--show')) {
  process.stderr.write('Usage: pnpm check:live <local-audio-file> [--show]\n');
  process.exit(1);
}
if (
  config.TRANSCRIPTION_PROVIDER !== 'groq' ||
  !['groq', 'gemini'].includes(config.LLM_PROVIDER) ||
  !config.GROQ_API_KEY
) {
  process.stderr.write(
    'Select Groq transcription and Gemini or Groq analysis, with their server-side keys configured. This command never uses fake providers.\n',
  );
  process.exit(1);
}
const redis = createRedis(config.REDIS_URL, 'meeting-hub-live-check');
const started = performance.now();
try {
  await redis.connect();
  const llm = configuredLlm(config, redis);
  const tools = {
    ffmpegPath: config.FFMPEG_PATH,
    threads: config.FFMPEG_THREADS,
    maxDurationSeconds: config.TRANSCRIPTION_MAX_DURATION_SECONDS,
  };
  const stt = new GroqTranscriptionProvider({
    key: config.GROQ_API_KEY,
    model: config.GROQ_STT_MODEL,
    tools,
    limiter: new RedisQuotaLimiter(redis, 'groq-stt', config.GROQ_API_KEY),
    hourSeconds: config.TRANSCRIPTION_QUOTA_SECONDS_PER_HOUR,
    daySeconds: config.TRANSCRIPTION_QUOTA_SECONDS_PER_DAY,
    rpm: config.GROQ_STT_RPM,
    rpd: config.GROQ_STT_RPD,
  });
  const signal = AbortSignal.timeout(20 * 60000);
  process.stdout.write(
    `Live check sends audio to Groq and transcript text to ${config.LLM_PROVIDER}${config.LLM_FALLBACK_PROVIDER ? ` (fallback: ${config.LLM_FALLBACK_PROVIDER})` : ''}.\n`,
  );
  await withJobDir(config.MEDIA_TMP_DIR, async (dir) => {
    const input = resolve(audioArg);
    const toolkit = new MediaToolkit({ ...tools, ffprobePath: config.FFPROBE_PATH });
    await toolkit.inspect(input, signal);
    const prepared = await prepareSpeechAudio(input, dir, tools, signal);
    const transcript = await stt.transcribe(prepared, {
      durationMs: prepared.durationMs,
      language: null,
      glossary: [],
      signal,
      beforeRequest: () => {
        signal.throwIfAborted();
        return Promise.resolve();
      },
    });
    const result = await extractLiveCheck(
      llm,
      transcript.segments.map((segment, idx) => ({
        idx,
        speaker: 'Speaker',
        name: 'Speaker',
        text: segment.text,
      })),
      signal,
    );
    process.stdout.write(
      JSON.stringify(
        {
          durationSeconds: prepared.durationMs / 1000,
          words: transcript.segments.reduce(
            (count, s) => count + s.text.split(/\s+/).filter(Boolean).length,
            0,
          ),
          speakerCount: transcript.segments.length ? 1 : 0,
          decisions: result.decisions.length,
          actionItems: result.actionItems.length,
          items: result.decisions.length + result.actionItems.length,
          citationValidityRate: result.citationValidityRate,
          itemsDropped: result.itemsDropped,
          lowConfidence: result.lowConfidence,
          runtimeSeconds: Math.round((performance.now() - started) / 100) / 10,
        },
        null,
        2,
      ) + '\n',
    );
    if (args.includes('--show'))
      process.stdout.write(
        JSON.stringify({ transcript: transcript.segments, document: result }, null, 2) + '\n',
      );
  });
} catch (error) {
  if (error instanceof ProviderRetryError)
    process.stderr.write(
      `${error.message} Estimated retry: ${new Date(Date.now() + error.retryAfterMs).toISOString()}\n`,
    );
  else
    process.stderr.write(
      error instanceof AppError
        ? `${error.code}: ${error.message}\n`
        : 'Live check failed. Verify the local file, media tools, Redis and configured provider credentials.\n',
    );
  process.exitCode = 1;
} finally {
  await redis.quit().catch(() => {});
}
