/**
 * Test media generated at run time (no large binaries in git): a valid 16-bit mono PCM WAV of
 * roughly `bytes` bytes (a quiet 440 Hz tone).
 */
export const WAV_SAMPLE_RATE = 44_100;

export function wavFixture(bytes: number): Buffer {
  const sampleRate = WAV_SAMPLE_RATE;
  const samples = Math.floor((bytes - 44) / 2);
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); // PCM header size
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28); // byte rate
  data.writeUInt16LE(2, 32); // block align
  data.writeUInt16LE(16, 34); // bits per sample
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(
      Math.round(2_000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)),
      44 + i * 2,
    );
  }
  return data;
}
