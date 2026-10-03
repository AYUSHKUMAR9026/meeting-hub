import {
  createPersonRequestSchema,
  peopleQuerySchema,
  personListSchema,
  personParamsSchema,
  personSchema,
  updatePersonRequestSchema,
  workspaceParamsSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import type { Person } from '../../modules/people';
import { iso, originOf } from '../caller';
import { problems, WORKSPACE_ERRORS } from './problems';

const toPerson = ({ workspaceId: _ws, ...p }: Person) => ({
  ...p,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

const FLAG = 'people.directory' as const;

export const peopleRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { people } = deps;

  app.get(
    '/v1/workspaces/:wid/people',
    {
      config: { access: { kind: 'workspace', action: 'people.read', flag: FLAG } },
      schema: {
        tags: ['people'],
        summary: 'The people directory (optionally searched)',
        params: workspaceParamsSchema,
        querystring: peopleQuerySchema,
        response: { 200: personListSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => ({
      people: (await people.list(workspaceActorOf(req), req.query)).map(toPerson),
    }),
  );

  app.post(
    '/v1/workspaces/:wid/people',
    {
      config: { access: { kind: 'workspace', action: 'people.create', flag: FLAG } },
      schema: {
        tags: ['people'],
        summary: 'Add someone to the directory',
        params: workspaceParamsSchema,
        body: createPersonRequestSchema,
        response: { 201: personSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      const person = await people.create(workspaceActorOf(req), req.body, originOf(req));
      return reply.status(201).send(toPerson(person));
    },
  );

  app.patch(
    '/v1/people/:id',
    {
      config: {
        access: { kind: 'workspace', action: 'people.update', workspaceFrom: 'person', flag: FLAG },
      },
      schema: {
        tags: ['people'],
        summary: 'Update a person',
        params: personParamsSchema,
        body: updatePersonRequestSchema,
        response: { 200: personSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req) =>
      toPerson(await people.update(workspaceActorOf(req), req.params.id, req.body, originOf(req))),
  );

  app.delete(
    '/v1/people/:id',
    {
      config: {
        access: { kind: 'workspace', action: 'people.delete', workspaceFrom: 'person', flag: FLAG },
      },
      schema: {
        tags: ['people'],
        summary: 'Remove a person from the directory',
        params: personParamsSchema,
        response: { 204: z.null().describe('No content'), ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await people.delete(workspaceActorOf(req), req.params.id, originOf(req));
      return reply.status(204).send(null);
    },
  );

  done();
};
