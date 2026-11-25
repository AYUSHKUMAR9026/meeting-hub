import pino, { type Logger, type LoggerOptions } from 'pino';

import type { Config } from './config';

export type { Logger };

/** Field names whose values must never reach logs (meeting content is sensitive). */
const SENSITIVE_FIELDS = [
  'token',
  'joinToken',
  'webhookBody',
  'LIVEKIT_API_SECRET',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'audioUrl',
  'audio_url',
  'prompt',
  'apiKey',
  'url',
  'transcript',
  'transcriptText',
  'utterances',
  'segments',
  'text',
  'content',
  'keyterms_prompt',
  'glossary',
];

/** pino redaction has no recursive wildcard, so cover the field at several depths. */
function atDepths(field: string, maxDepth = 4): string[] {
  return Array.from({ length: maxDepth + 1 }, (_, depth) =>
    [...Array<string>(depth).fill('*'), field].join('.'),
  );
}

export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-goog-api-key"]',
  'ASSEMBLYAI_API_KEY',
  'ANTHROPIC_API_KEY',
  ...[
    'summary',
    'paragraph',
    'bullets',
    'prompt',
    'decisions',
    'actionItems',
    'action_items',
    'rationale',
    'checkpoints',
  ].flatMap((field) => atDepths(field)),
  'headers.cookie',
  'req.body.q',
  'req.body.title',
  'req.body.description',
  ...SENSITIVE_FIELDS.flatMap((f) => atDepths(f)),
];

export function createLogger(
  config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>,
  bindings: Record<string, unknown> = {},
): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: 'meeting-hub', env: config.NODE_ENV, ...bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
  };
  if (config.NODE_ENV === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    };
  }
  return pino(options);
}
