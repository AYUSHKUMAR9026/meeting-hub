import type { Readable } from 'node:stream';
import type { SpeechAudio } from '../media';

export interface TranscriptionOptions {
  durationMs: number;
  language: string | null;
  glossary: readonly string[];
  signal: AbortSignal;
  beforeRequest?: () => Promise<void>;
}
export type CompletedTranscript = Extract<TranscriptionResult, { status: 'completed' }>;
export interface DirectTranscriptionOptions extends TranscriptionOptions {
  beforeRequest(): Promise<void>;
  cache?: {
    load(key: string): Promise<CompletedTranscript | undefined>;
    save(key: string, value: CompletedTranscript): Promise<void>;
    loadReceipt?(key: string): Promise<string | undefined>;
    saveReceipt?(key: string, jobId: string): Promise<void>;
    clearReceipt?(key: string): Promise<void>;
  };
}

export interface TranscriptSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export type TranscriptionResult =
  | { status: 'pending' }
  | { status: 'completed'; language: string | null; segments: TranscriptSegment[] };

export interface TranscriptionProvider {
  readonly name: 'groq' | 'assemblyai' | 'fake';
  transcribe?(
    audio: SpeechAudio,
    options: DirectTranscriptionOptions,
  ): Promise<CompletedTranscript>;
  submit(audio: Readable, options: TranscriptionOptions): Promise<string>;
  getResult(jobId: string, signal: AbortSignal): Promise<TranscriptionResult>;
}

/** Merge only nearby utterances from the same speaker, keeping each cue reasonably short. */
export function mergeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    const previous = merged.at(-1);
    if (
      previous?.speaker === segment.speaker &&
      segment.startMs >= previous.endMs &&
      segment.startMs - previous.endMs <= 600 &&
      segment.endMs - previous.startMs <= 20_000 &&
      previous.text.length + segment.text.length <= 420
    ) {
      const previousDuration = previous.endMs - previous.startMs;
      const duration = segment.endMs - segment.startMs;
      previous.confidence =
        previous.confidence === null || segment.confidence === null
          ? null
          : (previous.confidence * previousDuration + segment.confidence * duration) /
            (previousDuration + duration);
      previous.endMs = segment.endMs;
      previous.text += ' ' + segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}
