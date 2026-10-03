import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
  uniqueEmail,
} from './support/harness';

describe('people directory', () => {
  let t: TestApp;
  let owner: Session;
  let viewer: Session;
  let ws: string;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await createUser(t, 'people-owner');
    viewer = await createUser(t, 'people-viewer');
    ws = (await createWorkspace(t, owner, 'People Workspace')).id;
    await addMember(t, ws, owner, viewer, 'viewer');
  });
  afterAll(() => t?.close());

  const create = (as: Session, payload: Record<string, unknown>) =>
    call(t, as, { method: 'POST', url: `/v1/workspaces/${ws}/people`, payload });

  it('creates, updates and deletes a person', async () => {
    const created = await create(owner, {
      displayName: 'Grace Hopper',
      email: 'Grace@Example.TEST',
      aliases: ['Amazing Grace'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const person = created.json<{ id: string; email: string; userId: string | null }>();
    expect(person).toMatchObject({ email: 'grace@example.test', userId: null });

    const updated = await call(t, owner, {
      method: 'PATCH',
      url: `/v1/people/${person.id}`,
      payload: { displayName: 'Rear Admiral Grace Hopper' },
    });
    expect(updated.json()).toMatchObject({ displayName: 'Rear Admiral Grace Hopper' });

    const deleted = await call(t, owner, { method: 'DELETE', url: `/v1/people/${person.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await call(t, owner, { method: 'DELETE', url: `/v1/people/${person.id}` })).statusCode,
    ).toBe(404);
  });

  it('keeps emails unique per workspace (409 PERSON_EMAIL_TAKEN)', async () => {
    const email = uniqueEmail('dup');
    expect((await create(owner, { displayName: 'A', email })).statusCode).toBe(201);
    const dup = await create(owner, { displayName: 'B', email: email.toUpperCase() });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'PERSON_EMAIL_TAKEN' });
  });

  it('searches fuzzily by name, email and alias', async () => {
    await create(owner, { displayName: 'Katherine Johnson', aliases: ['Katie'] });
    const search = (q: string) =>
      call(t, viewer, {
        method: 'GET',
        url: `/v1/workspaces/${ws}/people?q=${encodeURIComponent(q)}`,
      }).then((r) =>
        r.json<{ people: { displayName: string }[] }>().people.map((p) => p.displayName),
      );

    expect(await search('Katherine')).toContain('Katherine Johnson');
    expect(await search('Katherin Jonson')).toContain('Katherine Johnson'); // trigram typo match
    expect(await search('katie')).toContain('Katherine Johnson');
    expect(await search('zzzz-no-match')).toEqual([]);
  });

  it('lets viewers read but not write (403)', async () => {
    expect(
      (await call(t, viewer, { method: 'GET', url: `/v1/workspaces/${ws}/people` })).statusCode,
    ).toBe(200);
    expect((await create(viewer, { displayName: 'Nope' })).statusCode).toBe(403);
  });

  it('lists members as people automatically', async () => {
    const res = await call(t, owner, { method: 'GET', url: `/v1/workspaces/${ws}/people` });
    const list = res.json<{ people: { userId: string | null }[] }>().people;
    expect(list.map((p) => p.userId)).toEqual(
      expect.arrayContaining([owner.userId, viewer.userId]),
    );
  });
});
