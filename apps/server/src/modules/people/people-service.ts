import { isUniqueViolation } from '../../lib/db';
import { ConflictError, NotFoundError } from '../../lib/errors';
import type { AuditService, RequestOrigin } from '../audit';
import type { WorkspaceActor } from '../auth';
import type { PeopleRepository, Person, PersonInput } from './people-repository';

const emailTaken = () =>
  new ConflictError('PERSON_EMAIL_TAKEN', 'Someone in this workspace already has that email');

/** People directory use cases. Authorization happens at the route (see http/access.ts). */
export class PeopleService {
  constructor(
    private readonly repo: PeopleRepository,
    private readonly audit: AuditService,
  ) {}

  list(actor: WorkspaceActor, options: { q?: string | undefined; limit: number }) {
    return this.repo.list(actor.workspaceId, options);
  }

  async create(actor: WorkspaceActor, input: PersonInput, origin: RequestOrigin): Promise<Person> {
    let person: Person;
    try {
      person = await this.repo.create(actor.workspaceId, input);
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
    await this.audit.record({
      action: 'person.created',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'person', id: person.id },
      origin,
    });
    return person;
  }

  async update(
    actor: WorkspaceActor,
    id: string,
    patch: Partial<PersonInput>,
    origin: RequestOrigin,
  ): Promise<Person> {
    let person: Person | undefined;
    try {
      person = await this.repo.update(actor.workspaceId, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
    if (!person) throw new NotFoundError('Person not found');
    await this.audit.record({
      action: 'person.updated',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'person', id },
      metadata: { fields: Object.keys(patch) },
      origin,
    });
    return person;
  }

  async delete(actor: WorkspaceActor, id: string, origin: RequestOrigin): Promise<void> {
    if (!(await this.repo.delete(actor.workspaceId, id)))
      throw new NotFoundError('Person not found');
    await this.audit.record({
      action: 'person.deleted',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'person', id },
      origin,
    });
  }

  /** Called when someone creates or joins a workspace. */
  ensureForMember(workspaceId: string, user: { id: string; name: string; email: string }) {
    return this.repo.ensureForUser(workspaceId, user);
  }

  workspaceIdForMember(personId: string, userId: string) {
    return this.repo.workspaceIdForMember(personId, userId);
  }
}
