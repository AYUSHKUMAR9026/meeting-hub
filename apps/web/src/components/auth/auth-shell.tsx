import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Centered card used by every sign-in / sign-up style page. */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-lg font-semibold tracking-tight">
        Meeting Hub
      </Link>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
