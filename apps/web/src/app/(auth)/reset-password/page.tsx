import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-shell';

import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password · Meeting Hub' };

export default function ResetPasswordPage() {
  return (
    <AuthShell title="Choose a new password">
      <Suspense>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
