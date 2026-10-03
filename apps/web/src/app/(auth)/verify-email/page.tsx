import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-shell';

import { VerifyEmail } from './verify-email';

export const metadata: Metadata = { title: 'Verify your email · Meeting Hub' };

export default function VerifyEmailPage() {
  return (
    <AuthShell title="Verify your email">
      <Suspense>
        <VerifyEmail />
      </Suspense>
    </AuthShell>
  );
}
