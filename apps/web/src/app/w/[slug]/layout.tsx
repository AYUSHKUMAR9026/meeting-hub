import { notFound } from 'next/navigation';

import { AppHeader } from '@/components/app/app-header';
import { WorkspaceProvider } from '@/components/app/workspace-context';
import { getMyWorkspaces, requireUser, serverApi } from '@/lib/api/server';

/**
 * Server-side session + membership check for everything under /w/[slug]. A workspace the user
 * doesn't belong to is a 404, mirroring the API.
 */
export default async function WorkspaceLayout({ children, params }: LayoutProps<'/w/[slug]'>) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}`);
  const workspaces = await getMyWorkspaces();
  const current = workspaces.find((w) => w.slug === slug);
  if (!current) notFound();

  const api = await serverApi();
  const { data: workspace } = await api.GET('/v1/workspaces/{wid}', {
    params: { path: { wid: current.id } },
  });
  if (!workspace) notFound();

  return (
    <div className="min-h-screen">
      <AppHeader user={user} workspaces={workspaces} current={current} />
      <WorkspaceProvider workspace={workspace} user={user}>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </WorkspaceProvider>
    </div>
  );
}
