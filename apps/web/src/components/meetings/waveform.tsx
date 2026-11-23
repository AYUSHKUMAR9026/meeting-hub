'use client';

import { useEffect, useRef } from 'react';

export function Waveform({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const controller = new AbortController();
    context.clearRect(0, 0, element.width, element.height);
    void (async () => {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) return;
      const peaks: unknown = ((await response.json()) as { data?: unknown }).data;
      if (
        !Array.isArray(peaks) ||
        !peaks.length ||
        peaks.length % 2 ||
        peaks.some((value) => typeof value !== 'number' || value < -128 || value > 127)
      )
        return;
      if (controller.signal.aborted) return;
      const { width, height } = element;
      const bucket = Math.max(1, Math.ceil(peaks.length / 2 / width));
      const columns = Math.ceil(peaks.length / 2 / bucket);
      context.fillStyle = getComputedStyle(element).color;
      for (let column = 0; column < columns; column++) {
        let minimum = 0;
        let maximum = 0;
        for (let i = column * bucket; i < Math.min((column + 1) * bucket, peaks.length / 2); i++) {
          minimum = Math.min(minimum, Number(peaks[2 * i]));
          maximum = Math.max(maximum, Number(peaks[2 * i + 1]));
        }
        const x = Math.floor((column * width) / columns);
        context.fillRect(
          x,
          ((128 - maximum) / 256) * height,
          Math.max(1, width / columns),
          Math.max(1, ((maximum - minimum) / 256) * height),
        );
      }
    })().catch(() => {
      /* Playback stays available when peaks cannot be loaded. */
    });
    return () => controller.abort();
  }, [url]);

  return (
    <canvas
      ref={canvas}
      width={1000}
      height={68}
      className="h-16 w-full rounded-md bg-muted text-primary"
      role="img"
      aria-label="Audio waveform"
    />
  );
}
