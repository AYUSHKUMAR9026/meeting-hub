'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';

import { FormError, FormField } from '@/components/app/form-field';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { authClient, safeReturnTo } from '@/lib/auth-client';
import { formValue } from '@/lib/form';

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    void api.GET('/v1/auth/providers').then(({ data }) => setGoogle(Boolean(data?.google)));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setNotice(null);
    const { error: signInError } = await authClient.signIn.email({
      email: formValue(form, 'email'),
      password: formValue(form, 'password'),
      callbackURL: `/verify-email?verified=1&returnTo=${encodeURIComponent(returnTo)}`,
    });
    if (!signInError) {
      // Refresh so server components re-render with the new session cookie.
      router.push(returnTo);
      router.refresh();
      return;
    }
    setPending(false);
    if (signInError.status === 403) {
      setNotice('Please verify your email first. We just sent you a new verification link.');
    } else if (signInError.status === 429) {
      setError('Too many attempts. Wait a minute and try again.');
    } else {
      setError('Wrong email or password.');
    }
  }

  const withReturn = (path: string) =>
    returnTo === '/' ? path : `${path}?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div className="grid gap-4">
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        <FormField id="email" label="Email" type="email" autoComplete="email" required />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
        />
        <FormError message={error} />
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {google && (
        <Button
          variant="outline"
          onClick={() =>
            void authClient.signIn.social({ provider: 'google', callbackURL: returnTo })
          }
        >
          Continue with Google
        </Button>
      )}
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="underline-offset-4 hover:underline">
          Forgot password?
        </Link>
        <Link href={withReturn('/sign-up')} className="underline-offset-4 hover:underline">
          Create an account
        </Link>
      </div>
    </div>
  );
}
