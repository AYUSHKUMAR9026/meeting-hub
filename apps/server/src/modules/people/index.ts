// Public API of the people module (the per-workspace directory of humans in meetings).
import type { Database } from '../../lib/db';
import type { AuditService } from '../audit';
import { PeopleRepository } from './people-repository';
import { PeopleService } from './people-service';

export { normalizeEmail, type Person, type PersonInput } from './people-repository';
export { PeopleService } from './people-service';

export function createPeopleService(deps: { db: Database; audit: AuditService }): PeopleService {
  return new PeopleService(new PeopleRepository(deps.db), deps.audit);
}
