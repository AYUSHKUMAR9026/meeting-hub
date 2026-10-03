// Public API of the platform module. Other modules, http/ and jobs/ import from here only.
import type { Config } from '../../lib/config';
import type { Database } from '../../lib/db';
import type { Logger } from '../../lib/logger';
import { DbFlagStore } from './flags/db-flag-store';
import { FeatureFlagService } from './flags/feature-flag-service';

export { type FlagKey, flagDefinitions } from './flags/definitions';
export {
  type FlagContext,
  type FlagEvaluation,
  type FlagRecord,
  type FlagSource,
  type FlagStore,
  FeatureFlagService,
} from './flags/feature-flag-service';

export function createFeatureFlagService(deps: {
  config: Pick<Config, 'NODE_ENV' | 'FEATURE_FLAGS_OVERRIDE' | 'FEATURE_FLAGS_CACHE_TTL_MS'>;
  db: Database;
  logger: Logger;
}): FeatureFlagService {
  return new FeatureFlagService({
    store: new DbFlagStore(deps.db),
    overrides: deps.config.FEATURE_FLAGS_OVERRIDE,
    ttlMs: deps.config.FEATURE_FLAGS_CACHE_TTL_MS,
    environment: deps.config.NODE_ENV,
    logger: deps.logger.child({ module: 'platform.flags' }),
  });
}
