'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import { FormError, FormField } from '@/components/app/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { authClient, safeReturnTo } from '@/lib/auth-client';

export function VerifyEmail() {
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const verified = params.get('verified') === '1' && !params.get('error');
  const linkError = params.get('error');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (verified) {
    return (
      <div className="grid gap-4">
        <p className="text-sm">Your email is verified and you&apos;re signed in.</p>
        <a href={returnTo} className={buttonVariants()}>
          Continue
        </a>
      </div>
    );
  }

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const { error: sendError } = await authClient.sendVerificationEmail({
      email,
      callbackURL: `/verify-email?verified=1&returnTo=${encodeURIComponent(returnTo)}`,
    });
    if (sendError) setError(sendError.message ?? 'Could not send the email.');
    else setSent(true);
  }

  return (
    <div className="grid gap-4">
      {linkError ? (
        <FormError message="That verification link is invalid or has expired. Send a new one below." />
      ) : (
        <p className="text-sm">
          We sent a verification link to {email ? <strong>{email}</strong> : 'your inbox'}. Click it
          to finish signing up.
        </p>
      )}
      <form onSubmit={(e) => void resend(e)} className="grid gap-3">
        <FormField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <FormError message={error} />
        <Button type="submit" variant="outline" disabled={sent}>
          {sent ? 'Sent — check your inbox' : 'Resend verification email'}
        </Button>
      </form>
      <Link href="/sign-in" className="text-sm underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}
