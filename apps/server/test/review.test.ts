import { describe, expect, it } from 'vitest';

import {
  exportFilename,
  renderDocument,
  renderTranscript,
  timecode,
} from '../src/modules/exports/render';
import {
  createShareToken,
  hashShareToken,
  isShareToken,
  publicText,
  shareExpiry,
} from '../src/modules/sharing/token';
import { literalSearch, pageCursor } from '../src/modules/tracking/queries';

import { docxXml, pdfText } from './support/export-readers';

describe('export rendering', () => {
  const blocks = [
    { text: 'Review & café <script>', level: 1 as const },
    { text: 'Summary' },
    { text: '[click](javascript:alert(1))' },
  ];

  it('escapes Markdown, Word and PDF content with each format renderer', async () => {
    const markdown = (await renderDocument(blocks, 'md')).toString();
    expect(markdown).toContain('# Review & café');
    expect(markdown).toContain('\\<script>');
    expect(markdown).toContain('\\[click]\\(javascript:');

    const word = docxXml(await renderDocument(blocks, 'docx'));
    expect(word).toContain('Review &amp; café &lt;script&gt;');
    expect(word).toContain('[click](javascript:alert(1))');
    expect(word).not.toContain('<script>');

    const pdf = await pdfText(await renderDocument(blocks, 'pdf'));
    expect(pdf).toContain('Review & café <script>');
    expect(pdf).toContain('Summary');
  });

  it('flattens SRT cue text and escapes player markup', () => {
    const cue = {
      startMs: 1_234,
      endMs: 5_678,
      speaker: 'A',
      label: 'A',
      text: '<b>café</b>\n\n&',
    };
    expect(renderTranscript([cue], 'txt')).toContain('[00:00:01] A: <b>café</b>  &');
    expect(renderTranscript([cue], 'srt')).toBe(
      '1\n00:00:01,234 --> 00:00:05,678\nA: &lt;b&gt;café&lt;/b&gt;  &amp;\n\n',
    );
    expect(timecode(3_601_002, true)).toBe('01:00:01,002');
  });

  it('constrains the attachment name to safe ASCII', () => {
    expect(exportFilename('../Café"\r\n X: a\\b', 'pdf')).toBe('meeting-cafe-x-a-b.pdf');
    expect(exportFilename('📄', 'md')).toBe('meeting.md');
    expect(exportFilename('a'.repeat(200), 'docx').length).toBeLessThan(90);
  });
});

describe('share tokens', () => {
  it('uses random path-safe tokens and stable hashes', () => {
    const token = createShareToken();
    expect(isShareToken(token)).toBe(true);
    expect(createShareToken()).not.toBe(token);
    expect(hashShareToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(isShareToken('../anything')).toBe(false);
  });

  it('honors the workspace deployment limit and absolute maximum', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(shareExpiry(now, 3, 4).toISOString()).toBe('2026-01-04T00:00:00.000Z');
    expect(() => shareExpiry(now, 5, 4)).toThrow(/1 to 4 days/);
    expect(() => shareExpiry(now, 91, 100)).toThrow(/1 to 90 days/);
    expect(() => shareExpiry(now, 0, 90)).toThrow();
    expect(publicText('Name <name+review@corp.test>')).toBe('Name <[email removed]>');
  });
});

describe('tracker filters', () => {
  it('escapes PostgreSQL pattern metacharacters and bounds offsets', () => {
    expect(literalSearch('50%_\\')).toBe('%50\\%\\_\\\\%');
    expect(pageCursor(3, 2, 2)).toBe(4);
    expect(pageCursor(2, 2, 2)).toBeNull();
    expect(pageCursor(3, 100_000, 2)).toBeNull();
  });
});
