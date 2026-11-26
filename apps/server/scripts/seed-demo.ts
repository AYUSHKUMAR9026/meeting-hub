/** Idempotent local demo seed. No production execution and no existing-user password changes. */
import { and, eq, member, organization, user } from '@meeting-hub/db';
import { buildApp } from '../src/app';
import { closeApiDeps, createApiDeps } from '../src/deps';
import { loadConfigOrExit } from '../src/lib/config';
import { createLogger } from '../src/lib/logger';

const config = loadConfigOrExit();
if (config.NODE_ENV !== 'development') throw new Error('Demo seed only runs in development.');
const deps = createApiDeps(
  { ...config, RATE_LIMIT_ENABLED: false },
  createLogger({ ...config, LOG_LEVEL: 'warn' }),
);
await deps.redis.connect();
const app = await buildApp(deps);
try {
  const identities = [];
  for (const [label, name] of [
    ['owner', 'Demo Owner'],
    ['alex', 'Alex Chen'],
    ['sam', 'Sam Patel'],
  ] as const) {
    const email = `${label}@meeting-hub.local`;
    let [row] = await deps.db.db.select().from(user).where(eq(user.email, email));
    if (!row) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: config.WEB_ORIGIN },
        payload: { email, name, password: 'meeting-hub-demo-2026' },
      });
      if (response.statusCode !== 200) throw new Error('Could not seed demo identity.');
      [row] = await deps.db.db.select().from(user).where(eq(user.email, email));
      await deps.db.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    }
    identities.push(row!);
  }
  const owner = identities[0]!;
  let [project] = await deps.db.db
    .select()
    .from(organization)
    .where(eq(organization.slug, 'demo-project'));
  if (!project) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: config.WEB_ORIGIN },
      payload: { email: owner.email, password: 'meeting-hub-demo-2026' },
    });
    const cookies = [response.headers['set-cookie'] ?? []]
      .flat()
      .map((c) => c.split(';')[0])
      .join('; ');
    if (response.statusCode !== 200)
      throw new Error('Existing demo account has different credentials; use another workspace.');
    await deps.workspaces.create(
      owner,
      { name: 'Demo project', slug: 'demo-project', timezone: 'Asia/Kolkata' },
      { headers: new Headers({ cookie: cookies }), origin: {} },
    );
    [project] = await deps.db.db
      .select()
      .from(organization)
      .where(eq(organization.slug, 'demo-project'));
  }
  for (const person of identities) {
    const [membership] = await deps.db.db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, project!.id), eq(member.userId, person.id)));
    if (!membership)
      await deps.db.db.insert(member).values({
        organizationId: project!.id,
        userId: person.id,
        role: person.id === owner.id ? 'owner' : 'member',
      });
    await deps.people.ensureForMember(project!.id, person);
  }
  process.stdout.write(
    'Demo project ready: owner, alex and sam @meeting-hub.local. See README for local sign-in.\n',
  );
} finally {
  await app.close();
  await closeApiDeps(deps);
}
