import type { Metadata } from 'next';

import { AuthShell } from '@/components/auth/auth-shell';
import { requireUser } from '@/lib/api/server';

import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Accept invitation · Meeting Hub' };

export default async function AcceptInvitationPage({
  params,
}: PageProps<'/accept-invitation/[id]'>) {
  const { id } = await params;
  const user = await requireUser(`/accept-invitation/${id}`);
  return (
    <AuthShell title="Workspace invitation">
      <AcceptInvitation id={id} email={user.email} />
    </AuthShell>
  );
}
