import { describe, expect, it } from 'vitest';

import {
  assertProcessable,
  downsamplePeaks,
  FORMAT_WHITELIST,
  ffprobeArgs,
  MAX_PEAK_POINTS,
  normalizeArgs,
  normalizedAudioKey,
  parseProbe,
  PeaksAccumulator,
  peaksKey,
  PROTOCOL_WHITELIST,
  toInt8,
} from '../src/modules/media';
import { PermanentError } from '../src/lib/errors';

const WS = '0199a000-0000-7000-8000-000000000001';
const MEETING = '0199a000-0000-7000-8000-000000000002';
const RUN = '0199a000-0000-7000-8000-000000000003';

/** The value following `flag` in an argument list (first occurrence after `from`). */
const after = (args: string[], flag: string, from = 0) => args[args.indexOf(flag, from) + 1];

describe('ffmpeg argument building', () => {
  const normalize = normalizeArgs({
    inputPath: '/tmp/job/input',
    outputPath: '/tmp/job/out.m4a',
    streamIndex: 1,
    threads: 2,
    maxSeconds: 10_801,
  });
  const probe = ffprobeArgs('/tmp/job/input');

  it.each([
    ['ffprobe', probe],
    ['ffmpeg', normalize],
  ])('%s always restricts protocols and demuxers before the input', (_name, args) => {
    const input = args.findIndex((a) => a.startsWith('file:'));
    expect(after(args, '-protocol_whitelist')).toBe(PROTOCOL_WHITELIST);
    expect(PROTOCOL_WHITELIST).toBe('file,pipe');
    expect(after(args, '-format_whitelist')).toBe(FORMAT_WHITELIST);
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(input);
    expect(args.indexOf('-format_whitelist')).toBeLessThan(input);
  });

  it('never lets playlist or network demuxers through the format whitelist', () => {
    const allowed = FORMAT_WHITELIST.split(',');
    for (const demuxer of ['hls', 'concat', 'dash', 'rtsp', 'http', 'image2', 'tty', 'lavfi']) {
      expect(allowed).not.toContain(demuxer);
    }
  });

  it('reads a local file URL, never a bare path or URL', () => {
    expect(probe.at(-1)).toBe('file:/tmp/job/input');
    expect(after(normalize, '-i')).toBe('file:/tmp/job/input');
    expect(normalize).toContain('file:/tmp/job/out.m4a');
    expect(() => ffprobeArgs('')).toThrow();
    expect(() => ffprobeArgs('/tmp/a\0b')).toThrow();
  });

  it('disables stdin, limits threads and caps duration', () => {
    expect(normalize).toContain('-nostdin');
    expect(after(normalize, '-threads')).toBe('2');
    expect(after(normalize, '-t')).toBe('10801');
  });

  it('writes mono 16 kHz AAC in M4A with the moov atom first, plus PCM on stdout', () => {
    const output = normalize.indexOf('file:/tmp/job/out.m4a');
    const encoder = normalize.slice(0, output);
    expect(after(encoder, '-map')).toBe('0:1');
    expect(after(encoder, '-c:a')).toBe('aac');
    expect(after(encoder, '-ac')).toBe('1');
    expect(after(encoder, '-ar')).toBe('16000');
    expect(after(encoder, '-movflags')).toBe('+faststart');
    expect(after(encoder, '-map_metadata')).toBe('-1');
    const pcm = normalize.slice(output);
    expect(after(pcm, '-f')).toBe('s16le');
    expect(pcm.at(-1)).toBe('pipe:1');
  });

  it('rejects an invalid stream index', () => {
    expect(() =>
      normalizeArgs({
        inputPath: 'a',
        outputPath: 'b',
        streamIndex: -1,
        threads: 1,
        maxSeconds: 1,
      }),
    ).toThrow();
  });
});

describe('storage keys for run outputs', () => {
  it('derives them from the run id under the meeting prefix', () => {
    expect(normalizedAudioKey(WS, MEETING, RUN)).toBe(
      `ws/${WS}/meetings/${MEETING}/normalized/${RUN}`,
    );
    expect(peaksKey(WS, MEETING, RUN)).toBe(`ws/${WS}/meetings/${MEETING}/peaks/${RUN}`);
    expect(() => peaksKey(WS, MEETING, '../../etc')).toThrow();
  });
});

describe('waveform peaks', () => {
  const pcm = (samples: number[]) => {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
  };

  it('keeps min/max per 100 ms window', () => {
    const acc = new PeaksAccumulator(40); // 4 samples per window
    acc.push(pcm([0, 1000, -2000, 50, 300, 300, 300, 300, -32768]));
    const peaks = acc.finish();
    expect(peaks).toMatchObject({ sample_rate: 40, samples_per_pixel: 4, bits: 8, length: 3 });
    expect(peaks.data).toEqual([toInt8(-2000), toInt8(1000), toInt8(300), toInt8(300), -128, -128]);
    expect(acc.sampleCount).toBe(9);
  });

  it('reassembles samples split across chunks', () => {
    const whole = new PeaksAccumulator(20);
    const split = new PeaksAccumulator(20);
    const data = pcm([1234, -4321, 32767, -32768, 7, 8]);
    whole.push(data);
    split.push(data.subarray(0, 3));
    split.push(data.subarray(3, 4));
    split.push(data.subarray(4, 11));
    split.push(data.subarray(11));
    expect(split.finish()).toEqual(whole.finish());
    expect(split.sampleCount).toBe(6);
  });

  it('caps the number of points for long recordings', () => {
    const windows = 3 * 3600 * 10; // three hours at 10 points per second
    const mins = Array.from({ length: windows }, (_, i) => -(i % 100));
    const maxs = Array.from({ length: windows }, (_, i) => i % 100);
    const out = downsamplePeaks(mins, maxs, MAX_PEAK_POINTS);
    expect(out.mins.length).toBeLessThanOrEqual(MAX_PEAK_POINTS);
    expect(out.factor).toBe(Math.ceil(windows / MAX_PEAK_POINTS));
    expect(Math.min(...out.mins)).toBe(-99);
    expect(Math.max(...out.maxs)).toBe(99);
  });

  it('leaves short recordings at full resolution', () => {
    const out = downsamplePeaks([1, 2, 3], [4, 5, 6], MAX_PEAK_POINTS);
    expect(out).toEqual({ mins: [1, 2, 3], maxs: [4, 5, 6], factor: 1 });
  });

  it('merges groups with min of mins and max of maxes', () => {
    expect(downsamplePeaks([5, -3, 2, 0, 9], [6, 1, 8, 4, 9], 2)).toEqual({
      mins: [-3, 0],
      maxs: [8, 9],
      factor: 3,
    });
  });
});

describe('probe classification', () => {
  const probeJson = (streams: unknown[], format: Record<string, unknown> = {}) =>
    JSON.stringify({ streams, format: { format_name: 'mov,mp4,m4a', ...format } });
  const limits = { maxDurationSeconds: 10_800 };

  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(PermanentError);
      return (err as PermanentError).code;
    }
    return null;
  };

  it('picks the default audio stream and reads its properties', () => {
    const info = parseProbe(
      probeJson(
        [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
          {
            index: 2,
            codec_type: 'audio',
            codec_name: 'opus',
            sample_rate: '48000',
            channels: 1,
            disposition: { default: 1 },
          },
        ],
        { duration: '61.5' },
      ),
    );
    expect(info).toEqual({
      formatName: 'mov,mp4,m4a',
      durationMs: 61_500,
      hasVideo: true,
      audio: { index: 2, codec: 'opus', sampleRate: 48_000, channels: 1 },
    });
    expect(codeOf(() => assertProcessable(info, limits))).toBeNull();
  });

  it('classifies unprocessable media with stable codes', () => {
    const audio = { index: 0, codec_type: 'audio', codec_name: 'mp3' };
    expect(
      codeOf(() =>
        assertProcessable(parseProbe(probeJson([{ index: 0, codec_type: 'video' }])), limits),
      ),
    ).toBe('NO_AUDIO_STREAM');
    expect(
      codeOf(() => assertProcessable(parseProbe(probeJson([audio], { duration: '0.4' })), limits)),
    ).toBe('MEDIA_TOO_SHORT');
    expect(
      codeOf(() =>
        assertProcessable(parseProbe(probeJson([audio], { duration: '10801' })), limits),
      ),
    ).toBe('MEDIA_TOO_LONG');
    expect(codeOf(() => parseProbe('not json'))).toBe('UNREADABLE_MEDIA');
  });

  it('allows an unknown duration (checked again after decoding)', () => {
    const info = parseProbe(probeJson([{ index: 0, codec_type: 'audio' }], { duration: 'N/A' }));
    expect(info.durationMs).toBeNull();
    expect(codeOf(() => assertProcessable(info, limits))).toBeNull();
  });

  it('keeps the internal reason out of the user-facing message', () => {
    try {
      assertProcessable(
        parseProbe(probeJson([{ index: 0, codec_type: 'audio' }], { duration: '99999' })),
        limits,
      );
    } catch (err) {
      const e = err as PermanentError;
      expect(e.message).toBe('The recording is longer than the 3-hour limit.');
      expect(e.details).toEqual({ internal: 'duration 99999000ms' });
    }
  });
});
