import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { toMarkdown } from 'mdast-util-to-markdown';

import type { TranscriptCue } from '../transcription';

export type ExportFormat = 'md' | 'docx' | 'pdf' | 'txt' | 'srt';
export type ExportBlock = { text: string; level?: 1 | 2 };
export const exportTypes: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
};

// XML 1.0 excludes most control characters. Flatten newlines inside source fields so a transcript
// cue cannot create an extra SRT record or a Markdown block with different semantics.
// eslint-disable-next-line no-control-regex
const unsafeControls = /[\u0000-\u001f\u007f-\u009f]/g;
export const cleanExportText = (value: string) => value.replace(unsafeControls, ' ').trim();

export function exportFilename(title: string, format: ExportFormat): string {
  const name = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 68)
    .replace(/-+$/g, '');
  return `meeting${name ? '-' + name : ''}.${format}`;
}

export function timecode(ms: number, fraction = false): string {
  const duration = Math.max(0, Math.round(ms));
  const hours = Math.floor(duration / 3_600_000);
  const minutes = Math.floor(duration / 60_000) % 60;
  const seconds = Math.floor(duration / 1000) % 60;
  return (
    [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':') +
    (fraction ? ',' + String(duration % 1000).padStart(3, '0') : '')
  );
}

export function renderTranscript(cues: TranscriptCue[], format: 'txt' | 'srt'): string {
  const escapeSrt = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return cues
    .map((cue, index) => {
      const line = cleanExportText(cue.speaker) + ': ' + cleanExportText(cue.text);
      if (format === 'txt') return `[${timecode(cue.startMs)}] ${line}\n`;
      return `${index + 1}\n${timecode(cue.startMs, true)} --> ${timecode(cue.endMs, true)}\n${escapeSrt(line)}\n\n`;
    })
    .join('');
}

interface PdfMake {
  addFonts(fonts: unknown): void;
  setUrlAccessPolicy(allow: () => boolean): void;
  setLocalAccessPolicy(allow: (path: string) => boolean): void;
  createPdf(definition: {
    content: { text: string; style?: string }[];
    styles: Record<string, { fontSize: number; bold: boolean }>;
  }): {
    getBuffer(): Promise<Buffer>;
  };
}
const require = createRequire(import.meta.url);
let pdfMake: PdfMake | undefined;

function renderPdf(blocks: ExportBlock[]) {
  if (!pdfMake) {
    pdfMake = require('pdfmake') as PdfMake;
    const fonts = require('pdfmake/fonts/Roboto') as { Roboto: Record<string, string> };
    const allowedFonts = new Set(Object.values(fonts.Roboto).map((file) => resolve(file)));
    pdfMake.setUrlAccessPolicy(() => false);
    pdfMake.setLocalAccessPolicy((file) => allowedFonts.has(resolve(file)));
    pdfMake.addFonts(fonts);
  }
  return pdfMake
    .createPdf({
      content: blocks.map(({ text, level }) => ({
        text,
        ...(level ? { style: 'heading' + level } : {}),
      })),
      styles: { heading1: { fontSize: 19, bold: true }, heading2: { fontSize: 14, bold: true } },
    })
    .getBuffer();
}

export async function renderDocument(
  blocks: ExportBlock[],
  format: 'md' | 'docx' | 'pdf',
): Promise<Buffer> {
  const clean = blocks.map((block) => ({ ...block, text: cleanExportText(block.text) }));
  if (format === 'md')
    return Buffer.from(
      toMarkdown({
        type: 'root',
        children: clean.map(({ text, level }) =>
          level
            ? { type: 'heading', depth: level, children: [{ type: 'text', value: text }] }
            : { type: 'paragraph', children: [{ type: 'text', value: text }] },
        ),
      }),
      'utf8',
    );
  if (format === 'docx')
    return Packer.toBuffer(
      new Document({
        sections: [
          {
            children: clean.map(
              ({ text, level }) =>
                new Paragraph({
                  text,
                  ...(level
                    ? { heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2 }
                    : {}),
                }),
            ),
          },
        ],
      }),
    );
  return renderPdf(clean);
}
