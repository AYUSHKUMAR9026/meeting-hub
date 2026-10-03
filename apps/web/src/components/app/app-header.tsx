'use client';

import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { User, WorkspaceSummary } from '@/lib/api/client';
import { authClient } from '@/lib/auth-client';

export function AppHeader({
  user,
  workspaces,
  current,
}: {
  user: User;
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const base = `/w/${current.slug}`;
  const nav: { href: string; label: string; isActive: (path: string) => boolean }[] = [
    { href: base, label: 'Dashboard', isActive: (p) => p === base },
    {
      href: `${base}/meetings`,
      label: 'Meetings',
      isActive: (p) => p.startsWith(`${base}/meetings`) || p.startsWith(`${base}/m/`),
    },
    {
      href: `${base}/settings`,
      label: 'Settings',
      isActive: (p) => p.startsWith(`${base}/settings`),
    },
  ];

  async function signOut() {
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
        <Link href={base} className="font-semibold tracking-tight">
          Meeting Hub
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" aria-label="Switch workspace" />}
          >
            <span className="max-w-40 truncate">{current.name}</span>
            <ChevronsUpDownIcon className="opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {workspaces.map((w) => (
                <DropdownMenuItem
                  key={w.id}
                  render={<Link href={`/w/${w.slug}`} />}
                  className="justify-between"
                >
                  <span className="truncate">{w.name}</span>
                  {w.id === current.id && <CheckIcon />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/onboarding" />}>
              <PlusIcon /> Create workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <nav className="flex gap-1 text-sm">
          {nav.map((item) => {
            const active = item.isActive(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-2 py-1 ${active ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
              {user.name}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void signOut()}>Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
