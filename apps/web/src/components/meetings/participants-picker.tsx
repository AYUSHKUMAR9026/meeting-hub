'use client';

import { XIcon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';

import { useWorkspace } from '@/components/app/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useApiQuery } from '@/hooks/use-api-query';
import { api } from '@/lib/api/client';

export interface PickedPerson {
  id: string;
  displayName: string;
}

/** Choose participants from the workspace's people directory (searchable). */
export function ParticipantsPicker({
  value,
  onChange,
  disabled,
}: {
  value: PickedPerson[];
  onChange: (value: PickedPerson[]) => void;
  disabled?: boolean;
}) {
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const people = useApiQuery(`participants:${workspace.id}:${q}`, () =>
    api.GET('/v1/workspaces/{wid}/people', {
      params: { path: { wid: workspace.id }, query: { limit: 50, ...(q ? { q } : {}) } },
    }),
  );
  const selected = new Set(value.map((p) => p.id));

  function toggle(person: PickedPerson) {
    onChange(
      selected.has(person.id) ? value.filter((p) => p.id !== person.id) : [...value, person],
    );
  }

  if (people.state.status === 'error' && people.state.httpStatus === 404) {
    return (
      <p className="text-sm text-muted-foreground">
        The people directory isn&apos;t enabled for this workspace, so participants can&apos;t be
        added yet.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Selected participants">
          {value.map((p) => (
            <Badge key={p.id} variant="secondary" className="gap-1 pr-1">
              {p.displayName}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${p.displayName}`}
                  onClick={() => toggle(p)}
                  className="rounded-full hover:bg-muted"
                >
                  <XIcon />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      <Input
        type="search"
        placeholder="Search people"
        aria-label="Search people"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="max-h-48 overflow-y-auto rounded-lg border">
        {people.state.status === 'loading' && (
          <p className="p-2 text-sm text-muted-foreground">Loading people…</p>
        )}
        {people.state.status === 'ok' && people.state.data.people.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">
            {q ? `Nobody matches “${q}”.` : 'No people in the directory yet.'}
          </p>
        )}
        {people.state.status === 'ok' &&
          people.state.data.people.map((person) => (
            <label
              key={person.id}
              className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.has(person.id)}
                disabled={disabled}
                onChange={() => toggle({ id: person.id, displayName: person.displayName })}
              />
              <span>{person.displayName}</span>
              {person.email && <span className="text-muted-foreground">{person.email}</span>}
            </label>
          ))}
      </div>
    </div>
  );
}
