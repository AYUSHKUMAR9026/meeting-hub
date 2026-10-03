'use client';

import { type FormEvent, useDeferredValue, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField } from '@/components/app/form-field';
import { useCan, useWorkspace } from '@/components/app/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, type Person, problemMessage } from '@/lib/api/client';
import { formValue } from '@/lib/form';

const splitAliases = (value: string) =>
  value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

export default function PeoplePage() {
  const workspace = useWorkspace();
  const can = useCan();
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const people = useApiQuery(`people:${workspace.id}:${q}`, () =>
    api.GET('/v1/workspaces/{wid}/people', {
      params: { path: { wid: workspace.id }, query: q ? { q } : {} },
    }),
  );

  if (people.state.status === 'error' && people.state.httpStatus === 404) {
    return (
      <p className="text-sm text-muted-foreground">
        The people directory isn&apos;t enabled for this workspace yet.
      </p>
    );
  }

  return (
    <div className="grid gap-6">
      {can('people.create') && <AddPersonCard onAdded={people.reload} />}
      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>
            Everyone who appears in meetings — members are added automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Input
            type="search"
            placeholder="Search by name, email or alias"
            aria-label="Search people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-sm"
          />
          {people.state.status === 'loading' && (
            <div className="grid gap-2" aria-busy="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {people.state.status === 'error' && (
            <FormError message={problemMessage(people.state.error, 'Could not load people.')} />
          )}
          {people.state.status === 'ok' &&
            (people.state.data.people.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {q ? `Nobody matches “${q}”.` : 'No people yet.'}
              </p>
            ) : (
              <PeopleTable people={people.state.data.people} onChanged={people.reload} />
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AddPersonCard({ onAdded }: { onAdded: () => void }) {
  const workspace = useWorkspace();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const email = formValue(form, 'email').trim();
    setError(null);
    const { error: apiError } = await api.POST('/v1/workspaces/{wid}/people', {
      params: { path: { wid: workspace.id } },
      body: {
        displayName: formValue(form, 'displayName'),
        email: email || null,
        aliases: splitAliases(formValue(form, 'aliases')),
      },
    });
    if (apiError) {
      setError(problemMessage(apiError, 'Could not add the person.'));
      return;
    }
    toast.success('Person added');
    formElement.reset();
    onAdded();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a person</CardTitle>
        <CardDescription>
          For people who join meetings but don&apos;t use Meeting Hub.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <FormField id="displayName" label="Name" required maxLength={120} />
          <FormField id="email" label="Email (optional)" type="email" />
          <FormField id="aliases" label="Aliases (comma-separated)" />
          <Button type="submit" className="sm:col-start-3 sm:justify-self-end">
            Add person
          </Button>
        </form>
        <div className="mt-3">
          <FormError message={error} />
        </div>
      </CardContent>
    </Card>
  );
}

function PeopleTable({ people, onChanged }: { people: Person[]; onChanged: () => void }) {
  const can = useCan();
  const [editing, setEditing] = useState<string | null>(null);

  async function save(person: Person, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = formValue(form, 'email').trim();
    const { error } = await api.PATCH('/v1/people/{id}', {
      params: { path: { id: person.id } },
      body: {
        displayName: formValue(form, 'displayName'),
        email: email || null,
        aliases: splitAliases(formValue(form, 'aliases')),
      },
    });
    if (error) {
      toast.error(problemMessage(error));
      return;
    }
    setEditing(null);
    onChanged();
  }

  async function remove(person: Person) {
    const { error } = await api.DELETE('/v1/people/{id}', { params: { path: { id: person.id } } });
    if (error) toast.error(problemMessage(error));
    else toast.success(`${person.displayName} removed`);
    onChanged();
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Aliases</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.map((person) =>
          editing === person.id ? (
            <TableRow key={person.id}>
              <TableCell colSpan={4}>
                <form
                  onSubmit={(e) => void save(person, e)}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Input
                    name="displayName"
                    defaultValue={person.displayName}
                    aria-label="Name"
                    required
                    className="w-48"
                  />
                  <Input
                    name="email"
                    type="email"
                    defaultValue={person.email ?? ''}
                    aria-label="Email"
                    className="w-56"
                  />
                  <Input
                    name="aliases"
                    defaultValue={person.aliases.join(', ')}
                    aria-label="Aliases"
                    className="w-48"
                  />
                  <Button type="submit" size="sm">
                    Save
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              </TableCell>
            </TableRow>
          ) : (
            <TableRow key={person.id}>
              <TableCell className="font-medium">
                {person.displayName}
                {person.userId && (
                  <Badge variant="secondary" className="ml-2">
                    member
                  </Badge>
                )}
              </TableCell>
              <TableCell>{person.email ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground">
                {person.aliases.join(', ') || '—'}
              </TableCell>
              <TableCell className="space-x-1 text-right">
                {can('people.update') && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(person.id)}>
                    Edit
                  </Button>
                )}
                {can('people.delete') && (
                  <Button variant="ghost" size="sm" onClick={() => void remove(person)}>
                    Delete
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </Table>
  );
}
