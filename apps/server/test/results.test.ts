import { describe, expect, it } from 'vitest';
import { assemblePdf } from '../src/modules/results/assemble';
import {
  audioPurgeReason,
  meetingDateTime,
  pdfIsDue,
  shouldPurgeTranscript,
} from '../src/modules/results/policy';

describe('saved meeting result policy', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  it('keeps audio on retry and quota waits, purges on success/failure, and enforces TTL', () => {
    const input = {
      now,
      createdAt: now,
      ttlHours: 48,
      transcribed: false,
      permanentlyFailed: false,
    };
    expect(audioPurgeReason(input)).toBeNull();
    expect(audioPurgeReason({ ...input, transcribed: true })).toBe('transcribed');
    expect(audioPurgeReason({ ...input, permanentlyFailed: true })).toBe('failed');
    expect(audioPurgeReason({ ...input, createdAt: new Date(now.getTime() - 48 * 3600000) })).toBe(
      'expired',
    );
  });
  it('debounces from the latest edit, including edits during the quiet period', () => {
    expect(pdfIsDue(null, now)).toBe(false);
    expect(pdfIsDue(new Date(now.getTime() - 4999), now)).toBe(false);
    expect(pdfIsDue(new Date(now.getTime() - 5000), now)).toBe(true);
  });
  it('purges transcript text only after verification, with opt-in preservation of existing data', () => {
    const input = {
      resultPolicy: 'temporary' as const,
      contentRetention: 'pdf_only' as const,
      pdfVerified: true,
    };
    expect(shouldPurgeTranscript(input)).toBe(true);
    expect(shouldPurgeTranscript({ ...input, pdfVerified: false })).toBe(false);
    expect(shouldPurgeTranscript({ ...input, contentRetention: 'keep_transcript' })).toBe(false);
    expect(shouldPurgeTranscript({ ...input, resultPolicy: 'legacy' })).toBe(false);
  });
  it('formats the project date across a calendar-day boundary', () => {
    expect(meetingDateTime(new Date('2026-11-26T23:30:00Z'), 'Asia/Kolkata')).toContain(
      '27 November 2026',
    );
    expect(meetingDateTime(now, 'UTC')).toContain('(UTC)');
  });
  it('assembles structured items with statuses, speakers and timestamps; appendix is opt-in', () => {
    const document = {
      id: 'd',
      transcriptId: 't',
      processingRunId: 'r',
      model: 'fake',
      promptVersion: 'v1',
      inputTokens: 0,
      outputTokens: 0,
      createdAt: now.toISOString(),
      isCurrent: true,
      lowConfidence: false,
      summary: { paragraph: 'A plan', bullets: ['Next step'] },
      decisions: [
        {
          id: 'i',
          idx: 0,
          title: 'Proceed',
          description: 'Ship the plan',
          rationale: null,
          status: 'confirmed' as const,
          editedByUser: false,
          lowConfidence: false,
          source: 'ai' as const,
          citations: [{ segmentId: 's', idx: 0, startMs: 61000, speaker: 'Alex' }],
        },
      ],
      actionItems: [],
    };
    const input = {
      projectName: 'Project',
      title: 'Planning',
      date: now,
      timezone: 'UTC',
      durationMs: 90000,
      participants: ['Alex'],
      document,
    };
    const text = assemblePdf(input)
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('Project');
    expect(text).toContain('Proceed — confirmed');
    expect(text).toContain('Alex 00:01:01');
    expect(text).not.toContain('Transcript appendix');
    expect(
      assemblePdf({
        ...input,
        transcript: [{ startMs: 0, speaker: 'Alex', text: 'Private words' }],
      })
        .map((b) => b.text)
        .join('\n'),
    ).toContain('[00:00:00] Alex: Private words');
  });
});
