import { assertTranscriptAllowed } from '../results';
import { Readable } from 'node:stream';

import type { Database } from '../../lib/db';
import { AppError, NotFoundError, isAppError } from '../../lib/errors';
import { withTimeout } from '../../lib/time';
import type { DocumentService } from '../analysis';
import type { AuditService, RequestOrigin } from '../audit';
import type { WorkspaceActor } from '../auth';
import type { MeetingService } from '../meetings';
import { readTranscriptSource, contentTooLarge } from '../transcription';
import {
  exportFilename,
  exportTypes,
  renderDocument,
  renderTranscript,
  timecode,
  type ExportBlock,
  type ExportFormat,
} from './render';

const TIMEOUT_MS = 15_000;

/** Exports never become stored files or public media URLs. */
export class ExportService {
  constructor(
    private readonly deps: {
      db: Database;
      documents: DocumentService;
      meetings: MeetingService;
      audit: AuditService;
      maxBytes: number;
    },
  ) {}

  async download(
    actor: WorkspaceActor,
    meetingId: string,
    format: ExportFormat,
    includeTranscript: boolean,
    origin: RequestOrigin,
  ) {
    if (includeTranscript || format === 'txt' || format === 'srt')
      await assertTranscriptAllowed(this.deps.db, actor.workspaceId, meetingId);
    const deadline = performance.now() + TIMEOUT_MS;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let output: { title: string; bytes: Buffer };
    try {
      output = await withTimeout(
        this.generate(actor, meetingId, format, includeTranscript, signal),
        TIMEOUT_MS + 50,
        'meeting export',
      );
      if (output.bytes.byteLength > this.deps.maxBytes) throw contentTooLarge();
      if (performance.now() > deadline) throw timeoutError();
    } catch (error) {
      if (signal.aborted || performance.now() > deadline) throw timeoutError();
      if (isAppError(error)) throw error;
      // eslint-disable-next-line preserve-caught-error -- renderers may include private meeting content in errors.
      throw new Error('Could not generate the export.');
    }
    await this.deps.audit.record({
      action: 'export.downloaded',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { format, includeTranscript },
      origin,
    });
    const bytes = output.bytes;
    return {
      filename: exportFilename(output.title, format),
      contentType: exportTypes[format],
      length: bytes.byteLength,
      stream: Readable.from(
        (function* () {
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
            yield bytes.subarray(offset, offset + 64 * 1024);
        })(),
      ),
    };
  }

  private async generate(
    actor: WorkspaceActor,
    meetingId: string,
    format: ExportFormat,
    includeTranscript: boolean,
    signal: AbortSignal,
  ) {
    const { db, documents, meetings, maxBytes } = this.deps;
    const meeting = await meetings.get(actor, meetingId);
    const scope = { workspaceId: actor.workspaceId, meetingId, maxBytes };
    signal.throwIfAborted();
    if (format === 'txt' || format === 'srt') {
      const cues = await readTranscriptSource(db, scope, signal);
      return { title: meeting.title, bytes: Buffer.from(renderTranscript(cues, format), 'utf8') };
    }
    const { document } = await documents.read(actor, meetingId);
    if (!document) throw new NotFoundError('Meeting document not found');

    const blocks: ExportBlock[] = [];
    let size = 0;
    const add = (text: string, level?: 1 | 2) => {
      size += Buffer.byteLength(text) + 16;
      if (size > maxBytes) throw contentTooLarge();
      blocks.push({ text, ...(level ? { level } : {}) });
    };
    const citations = (values: { startMs: number }[]) =>
      values.map(({ startMs }) => timecode(startMs)).join(', ');
    add(meeting.title, 1);
    add('Date: ' + meeting.occurredAt.toISOString());
    add(
      'Participants: ' +
        (meeting.participants.map(({ displayName }) => displayName).join(', ') || 'None listed'),
    );
    add('Summary', 2);
    add(document.summary.paragraph);
    for (const bullet of document.summary.bullets) add('• ' + bullet);
    add('Decisions', 2);
    for (const item of document.decisions) {
      if (item.status === 'rejected') continue;
      add(item.title + (item.status === 'proposed' ? ' — Unconfirmed' : ' — Confirmed'));
      add(item.description);
      if (item.rationale) add(item.rationale);
      if (item.citations.length) add('Evidence: ' + citations(item.citations));
    }
    add('Action items', 2);
    for (const item of document.actionItems) {
      if (item.status === 'rejected') continue;
      add(item.title + ' — ' + (item.status === 'done' ? 'Done' : 'Open'));
      add(item.description);
      add(
        'Owner: ' + (item.ownerName ?? 'Unassigned') + ' | Due: ' + (item.dueDate ?? 'No due date'),
      );
      if (item.citations.length) add('Evidence: ' + citations(item.citations));
    }
    if (includeTranscript) {
      add('Transcript', 2);
      const cues = await readTranscriptSource(
        db,
        { ...scope, transcriptId: document.transcriptId },
        signal,
      );
      for (const cue of cues) add(`[${timecode(cue.startMs)}] ${cue.speaker}: ${cue.text}`);
    }
    signal.throwIfAborted();
    return { title: meeting.title, bytes: await renderDocument(blocks, format) };
  }
}

function timeoutError() {
  return new AppError('EXPORT_TIMED_OUT', 'Generating this export took too long.', {
    status: 504,
    expose: true,
  });
}
