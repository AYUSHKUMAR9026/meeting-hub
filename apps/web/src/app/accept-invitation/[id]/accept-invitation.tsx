'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { FormError } from '@/components/app/form-field';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage } from '@/lib/api/client';
import { authClient } from '@/lib/auth-client';

export function AcceptInvitation({ id, email }: { id: string; email: string }) {
  const router = useRouter();
  const { state } = useApiQuery(`invitation:${id}`, () =>
    api.GET('/v1/invitations/{id}', { params: { path: { id } } }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchAccount() {
    await authClient.signOut();
    router.push(`/sign-in?returnTo=${encodeURIComponent(`/accept-invitation/${id}`)}`);
    router.refresh();
  }

  if (state.status === 'loading') {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="grid gap-4">
        <FormError
          message={
            state.httpStatus === 404
              ? `This invitation doesn't exist, has expired, or was sent to a different email. You're signed in as ${email}.`
              : problemMessage(state.error, 'Could not load the invitation.')
          }
        />
        <Button variant="outline" onClick={() => void switchAccount()}>
          Sign in with a different account
        </Button>
      </div>
    );
  }

  const invitation = state.data;

  async function accept() {
    setPending(true);
    setError(null);
    const { data, error: apiError } = await api.POST('/v1/invitations/{id}/accept', {
      params: { path: { id } },
    });
    if (data) {
      router.push(`/w/${data.workspace.slug}`);
      router.refresh();
      return;
    }
    setPending(false);
    setError(problemMessage(apiError, 'Could not accept the invitation.'));
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm">
        <strong>{invitation.inviterEmail}</strong> invited you to join{' '}
        <strong>{invitation.workspaceName}</strong> as <strong>{invitation.role}</strong>.
      </p>
      <FormError message={error} />
      <Button onClick={() => void accept()} disabled={pending}>
        {pending ? 'Joining…' : `Join ${invitation.workspaceName}`}
      </Button>
    </div>
  );
}
