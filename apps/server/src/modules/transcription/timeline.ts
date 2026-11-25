import type { TranscriptSegment } from './provider';

const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export function textSimilarity(a: string, b: string) {
  const left = words(a).slice(0, 200);
  const right = words(b).slice(0, 200);
  if (!left.length || !right.length) return 0;
  if (left.join(' ') === right.join(' ')) return 1;
  let previous = new Uint16Array(right.length + 1);
  for (const token of left) {
    const current = new Uint16Array(right.length + 1);
    for (let j = 0; j < right.length; j++)
      current[j + 1] =
        token === right[j] ? previous[j]! + 1 : Math.max(previous[j + 1]!, current[j]!);
    previous = current;
  }
  return (2 * previous[right.length]!) / (left.length + right.length);
}
function overlaps(a: TranscriptSegment, b: TranscriptSegment) {
  return (
    Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)) >=
    Math.min(a.endMs - a.startMs, b.endMs - b.startMs) * 0.5
  );
}
export function deduplicateOverlap(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const result: TranscriptSegment[] = [];
  let active: TranscriptSegment[] = [];
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    active = active.filter((prior) => prior.endMs > segment.startMs);
    if (
      !active.some(
        (prior) =>
          prior.speaker === segment.speaker &&
          overlaps(prior, segment) &&
          textSimilarity(prior.text, segment.text) >= 0.85,
      )
    ) {
      result.push(segment);
      active.push(segment);
    }
  }
  return result;
}
export interface TrackSegment extends TranscriptSegment {
  trackId: string;
  rms: number;
}
export function mergeTrackSegments(segments: readonly TrackSegment[]): TranscriptSegment[] {
  const kept: TrackSegment[] = [];
  const windows = new Map<number, TrackSegment[]>();
  for (const segment of [...segments].sort(
    (a, b) => b.rms - a.rms || a.trackId.localeCompare(b.trackId),
  )) {
    const candidates = new Set<TrackSegment>();
    const first = Math.floor(segment.startMs / 1000);
    const last = Math.floor(segment.endMs / 1000);
    for (let window = first; window <= last; window++)
      for (const prior of windows.get(window) ?? []) candidates.add(prior);
    if (
      ![...candidates].some(
        (prior) =>
          prior.trackId !== segment.trackId &&
          overlaps(prior, segment) &&
          textSimilarity(prior.text, segment.text) >= 0.85,
      )
    ) {
      kept.push(segment);
      for (let window = first; window <= last; window++) {
        const bucket = windows.get(window) ?? [];
        bucket.push(segment);
        windows.set(window, bucket);
      }
    }
  }
  return kept
    .sort((a, b) => a.startMs - b.startMs || a.speaker.localeCompare(b.speaker))
    .map(({ trackId: _track, rms: _rms, ...segment }) => {
      void _track;
      void _rms;
      return segment;
    });
}
export function estimateSpeechSeconds(durationsMs: readonly number[], chunks: number) {
  return (
    Math.ceil(durationsMs.reduce((sum, value) => sum + Math.max(0, value), 0) / 1000) + chunks * 10
  );
}
export function shouldUseMixed(seconds: number, hour: number, day: number, available = true) {
  return !available || seconds > Math.min(hour, day);
}
