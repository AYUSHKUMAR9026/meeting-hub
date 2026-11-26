export const PDF_DEBOUNCE_MS = 5_000;

export function shouldPurgeTranscript(input: {
  resultPolicy: 'legacy' | 'temporary';
  contentRetention: 'pdf_only' | 'keep_transcript';
  pdfVerified: boolean;
}): boolean {
  return (
    input.resultPolicy === 'temporary' && input.contentRetention === 'pdf_only' && input.pdfVerified
  );
}

export function pdfIsDue(dirtyAt: Date | null, now: Date): boolean {
  return dirtyAt !== null && now.getTime() - dirtyAt.getTime() >= PDF_DEBOUNCE_MS;
}

export function audioPurgeReason(input: {
  createdAt: Date;
  now: Date;
  ttlHours: number;
  transcribed: boolean;
  permanentlyFailed: boolean;
}): 'expired' | 'transcribed' | 'failed' | null {
  if (input.now.getTime() >= input.createdAt.getTime() + input.ttlHours * 3_600_000)
    return 'expired';
  if (input.transcribed) return 'transcribed';
  return input.permanentlyFailed ? 'failed' : null;
}

export function meetingDateTime(date: Date, timezone: string): string {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(date) +
    ' (' +
    timezone +
    ')'
  );
}
