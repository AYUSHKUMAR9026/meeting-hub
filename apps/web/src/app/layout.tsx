import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Geist } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Meeting Hub',
  description: 'Evidence-linked decisions and action items across your meetings.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', geist.variable)} suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
