import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-shell';

import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in · Meeting Hub' };

export default function SignInPage() {
  return (
    <AuthShell title="Sign in" description="Welcome back to Meeting Hub.">
      <Suspense>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}
