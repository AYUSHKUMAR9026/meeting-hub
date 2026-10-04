/**
 * Media fixtures generated with the real ffmpeg at test time (nothing binary is committed). Generator
 * inputs use lavfi sources; only the code under test is restricted to the format whitelist.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const ffmpeg = (args: string[]) =>
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

export interface Fixture {
  path: string;
  fileName: string;
  contentType: string;
  /** Duration we generated, for assertions (seconds). */
  seconds?: number;
}

export type FixtureName =
  | 'videoMp4'
  | 'audioM4a'
  | 'audioWav'
  | 'longerMp3'
  | 'empty'
  | 'truncatedMp4'
  | 'textAsMp3'
  | 'noAudioMp4'
  | 'tooShortWav'
  | 'tooLongMp3';

/** Generates every fixture into `dir`. `tooLongSeconds` is the length of the over-limit file. */
export function generateFixtures(
  dir: string,
  tooLongSeconds: number,
): Record<FixtureName, Fixture> {
  const at = (name: string) => join(dir, name);
  const sine = (seconds: number, rate = 44_100) => [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=${rate}:duration=${seconds}`,
  ];
  const video = (seconds: number) => [
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=160x120:rate=10:duration=${seconds}`,
  ];

  // A video with a stereo AAC track (moov at the end, like many phones write it).
  ffmpeg([...video(3), ...sine(3), '-ac', '2', '-c:v', 'mpeg4', '-c:a', 'aac', at('video.mp4')]);
  ffmpeg([...sine(4), '-ac', '2', '-c:a', 'aac', '-b:a', '96k', at('audio.m4a')]);
  ffmpeg([...sine(2.5, 48_000), '-ac', '2', '-c:a', 'pcm_s16le', at('audio.wav')]);
  // Long enough that a step is observably "running" for a while (cancellation, kill tests).
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=pink:sample_rate=22050:duration=1800',
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '32k',
    at('longer.mp3'),
  ]);
  ffmpeg([...video(2), '-c:v', 'mpeg4', '-an', at('noaudio.mp4')]);
  ffmpeg([...sine(0.4, 16_000), '-c:a', 'pcm_s16le', at('short.wav')]);
  // Over the duration limit, cheaply: low-bitrate mono silence.
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=8000:cl=mono`,
    '-t',
    String(tooLongSeconds),
    '-c:a',
    'libmp3lame',
    '-b:a',
    '8k',
    at('toolong.mp3'),
  ]);
  writeFileSync(at('empty.bin'), Buffer.alloc(0));
  writeFileSync(
    at('not-audio.mp3'),
    'This is a plain text file pretending to be an MP3.\n'.repeat(50),
  );
  // Cut a video short: with the moov atom at the end, nothing is readable.
  const whole = readFileSync(at('video.mp4'));
  writeFileSync(at('truncated.mp4'), whole.subarray(0, Math.floor(whole.length * 0.6)));

  const f = (path: string, fileName: string, contentType: string, seconds?: number): Fixture => ({
    path: at(path),
    fileName,
    contentType,
    ...(seconds !== undefined ? { seconds } : {}),
  });
  return {
    videoMp4: f('video.mp4', 'Screen recording.mp4', 'video/mp4', 3),
    audioM4a: f('audio.m4a', 'Voice memo.m4a', 'audio/mp4', 4),
    audioWav: f('audio.wav', 'Interview.wav', 'audio/wav', 2.5),
    longerMp3: f('longer.mp3', 'Long call.mp3', 'audio/mpeg', 1800),
    empty: f('empty.bin', 'empty.mp3', 'audio/mpeg'),
    truncatedMp4: f('truncated.mp4', 'Broken.mp4', 'video/mp4'),
    textAsMp3: f('not-audio.mp3', 'notes.mp3', 'audio/mpeg'),
    noAudioMp4: f('noaudio.mp4', 'Silent screen.mp4', 'video/mp4'),
    tooShortWav: f('short.wav', 'Blip.wav', 'audio/wav', 0.4),
    tooLongMp3: f('toolong.mp3', 'Marathon.mp3', 'audio/mpeg', tooLongSeconds),
  };
}

/** An HLS playlist dressed as an MP3 whose segments point at `url` and at a local file. */
export function writeDisguisedPlaylist(dir: string, url: string): Fixture {
  const path = join(dir, 'playlist.mp3');
  writeFileSync(
    path,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:10.0,',
      `${url}/segment0.ts`,
      '#EXTINF:10.0,',
      'file:///etc/passwd',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );
  return { path, fileName: 'podcast.mp3', contentType: 'audio/mpeg' };
}

/** ffprobe's view of a local file's first audio stream. */
export function probeAudio(path: string): {
  codec: string;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
} {
  const out = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels:format=duration',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const json = JSON.parse(out) as {
    streams: { codec_name: string; sample_rate: string; channels: number }[];
    format: { duration: string };
  };
  const s = json.streams[0]!;
  return {
    codec: s.codec_name,
    sampleRate: Number(s.sample_rate),
    channels: s.channels,
    durationSeconds: Number(json.format.duration),
  };
}

export const sizeOf = (path: string) => statSync(path).size;
