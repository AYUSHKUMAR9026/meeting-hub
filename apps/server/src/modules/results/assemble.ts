import type { MeetingDocumentResponse } from '@meeting-hub/contracts';
import { timecode, type ExportBlock } from '../exports';
import { meetingDateTime } from './policy';

export function assemblePdf(input: {
  projectName: string;
  title: string;
  date: Date;
  timezone: string;
  durationMs: number | null;
  participants: string[];
  document: NonNullable<MeetingDocumentResponse['document']>;
  transcript?: { startMs: number; speaker: string; text: string }[];
}): ExportBlock[] {
  const blocks: ExportBlock[] = [];
  const add = (text: string, level?: 1 | 2) => blocks.push({ text, ...(level ? { level } : {}) });
  add(input.projectName, 1);
  add(input.title, 1);
  add('Date: ' + meetingDateTime(input.date, input.timezone));
  add('Duration: ' + (input.durationMs === null ? 'Unavailable' : timecode(input.durationMs)));
  add('Participants: ' + (input.participants.join(', ') || 'None listed'));
  add('Summary', 2);
  add(input.document.summary.paragraph);
  for (const bullet of input.document.summary.bullets) add('• ' + bullet);
  for (const [heading, items] of [
    ['Decisions', input.document.decisions],
    ['Action items', input.document.actionItems],
  ] as const) {
    add(heading, 2);
    for (const item of items) {
      add(item.title + ' — ' + item.status);
      add(item.description);
      if ('rationale' in item && item.rationale) add(item.rationale);
      if ('ownerName' in item)
        add(
          'Owner: ' +
            (item.ownerName ?? 'Unassigned') +
            ' | Due: ' +
            (item.dueDate ?? 'No due date'),
        );
      if (item.citations.length)
        add(
          'Citations: ' +
            item.citations
              .map((c) => (c.speaker ?? 'Speaker') + ' ' + timecode(c.startMs))
              .join(', '),
        );
    }
  }
  if (input.transcript) {
    add('Transcript appendix', 2);
    for (const cue of input.transcript)
      add(`[${timecode(cue.startMs)}] ${cue.speaker}: ${cue.text}`);
  }
  return blocks;
}
