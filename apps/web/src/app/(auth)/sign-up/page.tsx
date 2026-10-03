import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-shell';

import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create account · Meeting Hub' };

export default function SignUpPage() {
  return (
    <AuthShell title="Create your account" description="We'll email you a link to confirm it.">
      <Suspense>
        <SignUpForm />
      </Suspense>
    </AuthShell>
  );
}
