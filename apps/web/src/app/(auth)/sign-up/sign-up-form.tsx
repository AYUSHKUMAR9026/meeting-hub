'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import { FormError, FormField } from '@/components/app/form-field';
import { Button } from '@/components/ui/button';
import { authClient, safeReturnTo } from '@/lib/auth-client';
import { formValue } from '@/lib/form';

export function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = formValue(form, 'email');
    setPending(true);
    setError(null);
    const { error: signUpError } = await authClient.signUp.email({
      name: formValue(form, 'name'),
      email,
      password: formValue(form, 'password'),
      // Where the emailed verification link lands (signed in) once clicked.
      callbackURL: `/verify-email?verified=1&returnTo=${encodeURIComponent(returnTo)}`,
    });
    if (signUpError) {
      setPending(false);
      setError(
        signUpError.status === 429
          ? 'Too many sign-ups from here. Try again in a few minutes.'
          : (signUpError.message ?? 'Could not create the account.'),
      );
      return;
    }
    router.push(
      `/verify-email?email=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(returnTo)}`,
    );
  }

  return (
    <div className="grid gap-4">
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        <FormField id="name" label="Name" autoComplete="name" required maxLength={80} />
        <FormField id="email" label="Email" type="email" autoComplete="email" required />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          hint="At least 10 characters."
        />
        <FormError message={error} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}
          className="text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
