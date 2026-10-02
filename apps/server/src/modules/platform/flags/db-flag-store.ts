import { featureFlags } from '@meeting-hub/db';

import type { Database } from '../../../lib/db';
import type { FlagRecord, FlagStore } from './feature-flag-service';

export class DbFlagStore implements FlagStore {
  constructor(private readonly db: Database) {}

  async loadAll(): Promise<FlagRecord[]> {
    return this.db
      .select({
        key: featureFlags.key,
        workspaceId: featureFlags.workspaceId,
        enabled: featureFlags.enabled,
      })
      .from(featureFlags);
  }
}
