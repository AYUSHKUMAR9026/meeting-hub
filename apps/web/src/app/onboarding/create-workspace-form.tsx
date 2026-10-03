'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import { FormError, FormField } from '@/components/app/form-field';
import { Button } from '@/components/ui/button';
import { api, problemMessage } from '@/lib/api/client';
import { formValue } from '@/lib/form';

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const name = formValue(new FormData(event.currentTarget), 'name');
    const { data, error: apiError } = await api.POST('/v1/workspaces', {
      body: { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    if (data) {
      router.push(`/w/${data.slug}`);
      router.refresh();
      return;
    }
    setPending(false);
    setError(problemMessage(apiError, 'Could not create the workspace.'));
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
      <FormField
        id="name"
        label="Workspace name"
        placeholder="Acme Inc."
        required
        maxLength={80}
        autoFocus
      />
      <FormError message={error} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create workspace'}
      </Button>
    </form>
  );
}
