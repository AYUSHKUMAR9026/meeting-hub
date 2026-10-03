import { redirect } from 'next/navigation';

import { getMyWorkspaces, requireUser } from '@/lib/api/server';

/** Entry point: sign in, then onboarding (no workspace yet) or the first workspace. */
export default async function HomePage() {
  await requireUser('/');
  const [first] = await getMyWorkspaces();
  redirect(first ? `/w/${first.slug}` : '/onboarding');
}
