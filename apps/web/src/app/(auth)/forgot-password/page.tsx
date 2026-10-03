'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { FormError, FormField } from '@/components/app/form-field';
import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { formValue } from '@/lib/form';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: requestError } = await authClient.requestPasswordReset({
      email: formValue(new FormData(event.currentTarget), 'email'),
      redirectTo: '/reset-password',
    });
    setPending(false);
    if (requestError) {
      setError(
        requestError.status === 429
          ? 'Too many requests. Try again in a few minutes.'
          : (requestError.message ?? 'Could not send the email.'),
      );
    } else {
      setSent(true);
    }
  }

  return (
    <AuthShell title="Reset your password" description="We'll email you a reset link.">
      {sent ? (
        <p role="status" className="text-sm">
          If an account exists for that email, a reset link is on its way. It expires in 1 hour.
        </p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <FormField id="email" label="Email" type="email" autoComplete="email" required />
          <FormError message={error} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
      <Link href="/sign-in" className="mt-4 block text-sm underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}
