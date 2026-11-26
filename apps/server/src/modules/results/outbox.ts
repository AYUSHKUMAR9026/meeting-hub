import { z } from 'zod';
import type { OutboxHandler } from '../platform';
import type { ResultService } from './service';

export const PDF_REQUESTED = 'document.pdf_requested';
const payload = z.object({ workspaceId: z.uuid(), meetingId: z.uuid() });

/** Delivery is opportunistic; the durable dirty marker also survives lost delivery or a crash. */
export function resultOutboxHandler(results: ResultService): OutboxHandler {
  return {
    type: PDF_REQUESTED,
    flag: 'analysis.enabled',
    handle: (event) => {
      const { workspaceId, meetingId } = payload.parse(event.payload);
      return Promise.resolve(async () => {
        await results.settle(workspaceId, meetingId);
      });
    },
  };
}
