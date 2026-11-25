import { eq, workspaceSettings } from '@meeting-hub/db';
import type { Database } from '../../lib/db';
import { PermanentError } from '../../lib/errors';

/** Called immediately before every external request, including fallback and resumed chunks. */
export async function assertExternalAiEnabled(db: Database, workspaceId: string) {
  const [settings] = await db
    .select({ enabled: workspaceSettings.externalAiEnabled })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  if (!settings?.enabled)
    throw new PermanentError(
      'EXTERNAL_AI_DISABLED',
      'External AI processing is not enabled for this workspace',
    );
}
