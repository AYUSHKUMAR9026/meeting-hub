import { sql } from '@meeting-hub/db';
import { z } from 'zod';

import type { OutboxHandler } from '../platform';

const payload = z.object({ workspaceId: z.uuid() });

/** A durable marker and periodic maintenance sweep repair lost queue deliveries. */
export function progressOutboxHandler(): OutboxHandler {
  return {
    type: 'progress.changed',
    // Always drain notifications. Keeping them deferred while disabled can starve unrelated
    // event types behind the dispatcher's bounded scan. Only snapshot aggregation is flag-gated.
    async handle(event, tx) {
      const { workspaceId } = payload.parse(event.payload);
      await tx.execute(sql`INSERT INTO progress_refresh_requests(workspace_id, available_at)
        SELECT workspace_id, now() + interval '5 seconds' FROM workspace_settings WHERE workspace_id = ${workspaceId}
        ON CONFLICT (workspace_id) DO UPDATE SET available_at = progress_refresh_requests.available_at`);
      // Even coalesced notifications acquire a new row version. A concurrent repeatable-read
      // snapshot cannot delete an older marker after observing state preceding this notification:
      // Postgres aborts that snapshot with a serialization failure, and maintenance retries it.
    },
  };
}
