'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import { FormError, FormField } from '@/components/app/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { formValue } from '@/lib/form';

export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get('token');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  if (!token || params.get('error')) {
    return (
      <div className="grid gap-4">
        <FormError message="This reset link is invalid or has expired." />
        <Link href="/forgot-password" className={buttonVariants({ variant: 'outline' })}>
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <p role="status" className="text-sm">
          Your password has been changed. You&apos;ve been signed out everywhere.
        </p>
        <Link href="/sign-in" className={buttonVariants()}>
          Sign in
        </Link>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = formValue(form, 'password');
    if (newPassword !== formValue(form, 'confirm')) {
      setError('The passwords do not match.');
      return;
    }
    setPending(true);
    setError(null);
    const { error: resetError } = await authClient.resetPassword({ newPassword, token: token! });
    setPending(false);
    if (resetError) setError(resetError.message ?? 'Could not reset the password.');
    else setDone(true);
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
      <FormField
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={128}
        hint="At least 10 characters."
      />
      <FormField
        id="confirm"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        required
      />
      <FormError message={error} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  );
}
