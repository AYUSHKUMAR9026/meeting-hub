'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useWorkspace } from '@/components/app/workspace-context';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { slug } = useWorkspace();
  const pathname = usePathname();
  const base = `/w/${slug}/settings`;
  const tabs = [
    { href: base, label: 'General' },
    { href: `${base}/members`, label: 'Members' },
    { href: `${base}/people`, label: 'People' },
  ];
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <nav className="flex gap-1 border-b text-sm" aria-label="Settings sections">
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 ${active ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
