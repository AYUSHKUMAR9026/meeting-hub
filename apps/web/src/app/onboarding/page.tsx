import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthShell } from '@/components/auth/auth-shell';
import { getMyWorkspaces, requireUser } from '@/lib/api/server';

import { CreateWorkspaceForm } from './create-workspace-form';

export const metadata: Metadata = { title: 'Create a workspace · Meeting Hub' };

export default async function OnboardingPage() {
  const user = await requireUser('/onboarding');
  const workspaces = await getMyWorkspaces();
  return (
    <AuthShell
      title={workspaces.length ? 'Create another workspace' : `Welcome, ${user.name}`}
      description="A workspace holds your team's meetings, decisions and action items."
    >
      <CreateWorkspaceForm />
      <p className="mt-4 text-sm text-muted-foreground">
        {workspaces.length ? (
          <Link href={`/w/${workspaces[0]!.slug}`} className="underline-offset-4 hover:underline">
            Back to {workspaces[0]!.name}
          </Link>
        ) : (
          'Were you invited to a workspace? Open the link in your invitation email instead.'
        )}
      </p>
    </AuthShell>
  );
}
