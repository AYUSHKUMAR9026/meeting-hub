import { and, asc, desc, eq, ilike, isNull, member, or, people, sql } from '@meeting-hub/db';

import type { Database } from '../../lib/db';

export interface Person {
  id: string;
  workspaceId: string;
  displayName: string;
  email: string | null;
  userId: string | null;
  aliases: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PersonInput {
  displayName: string;
  email?: string | null | undefined;
  aliases?: string[] | undefined;
}

export const normalizeEmail = (email: string | null | undefined) =>
  email ? email.trim().toLowerCase() : null;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Data access for the people directory. Every method takes `workspaceId` (or resolves it through
 * the caller's membership): there is deliberately no way to query people across workspaces.
 */
export class PeopleRepository {
  constructor(private readonly db: Database) {}

  async list(workspaceId: string, options: { q?: string | undefined; limit: number }) {
    const q = options.q?.trim();
    const where = q
      ? and(
          eq(people.workspaceId, workspaceId),
          or(
            ilike(people.displayName, `%${escapeLike(q)}%`),
            ilike(people.email, `%${escapeLike(q)}%`),
            sql`${people.displayName} % ${q}`,
            sql`${q} ILIKE ANY (${people.aliases})`,
          ),
        )
      : eq(people.workspaceId, workspaceId);
    return this.db
      .select()
      .from(people)
      .where(where)
      .orderBy(
        ...(q ? [desc(sql`similarity(${people.displayName}, ${q})`)] : []),
        asc(people.displayName),
        asc(people.id),
      )
      .limit(options.limit);
  }

  async findById(workspaceId: string, id: string): Promise<Person | undefined> {
    const [row] = await this.db
      .select()
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)));
    return row;
  }

  async create(workspaceId: string, input: PersonInput): Promise<Person> {
    const [row] = await this.db
      .insert(people)
      .values({
        workspaceId,
        displayName: input.displayName,
        email: normalizeEmail(input.email),
        aliases: input.aliases ?? [],
      })
      .returning();
    return row!;
  }

  async update(
    workspaceId: string,
    id: string,
    patch: Partial<PersonInput>,
  ): Promise<Person | undefined> {
    const [row] = await this.db
      .update(people)
      .set({
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.email !== undefined ? { email: normalizeEmail(patch.email) } : {}),
        ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)))
      .returning();
    return row;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)))
      .returning({ id: people.id });
    return rows.length > 0;
  }

  /**
   * Makes sure a workspace member has a person row: reuses the one linked to the user, else links
   * an unlinked row with the same email, else creates one. Idempotent and safe under races.
   */
  async ensureForUser(
    workspaceId: string,
    user: { id: string; name: string; email: string },
  ): Promise<{ person: Person; created: boolean }> {
    const email = normalizeEmail(user.email)!;
    const linked = await this.findByUser(workspaceId, user.id);
    if (linked) return { person: linked, created: false };

    const [byEmail] = await this.db
      .update(people)
      .set({ userId: user.id, updatedAt: new Date() })
      .where(
        and(eq(people.workspaceId, workspaceId), eq(people.email, email), isNull(people.userId)),
      )
      .returning();
    if (byEmail) return { person: byEmail, created: false };

    const [inserted] = await this.db
      .insert(people)
      .values({ workspaceId, displayName: user.name, email, userId: user.id })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { person: inserted, created: true };

    // Lost a race, or the email belongs to a person already linked to someone else.
    const existing = await this.findByUser(workspaceId, user.id);
    if (existing) return { person: existing, created: false };
    const [withoutEmail] = await this.db
      .insert(people)
      .values({ workspaceId, displayName: user.name, userId: user.id })
      .onConflictDoNothing()
      .returning();
    return {
      person: withoutEmail ?? (await this.findByUser(workspaceId, user.id))!,
      created: true,
    };
  }

  /**
   * The workspace a person belongs to, but only if `userId` is a member of it. Used to authorize
   * `/v1/people/{id}` routes without an unscoped lookup.
   */
  async workspaceIdForMember(personId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ workspaceId: people.workspaceId })
      .from(people)
      .innerJoin(
        member,
        and(eq(member.organizationId, people.workspaceId), eq(member.userId, userId)),
      )
      .where(eq(people.id, personId));
    return row?.workspaceId ?? null;
  }

  private async findByUser(workspaceId: string, userId: string): Promise<Person | undefined> {
    const [row] = await this.db
      .select()
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.userId, userId)));
    return row;
  }
}
