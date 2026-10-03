import type { VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import Link from 'next/link';
import type { ComponentProps } from 'react';

import { buttonVariants } from '@/components/ui/button';

/** A navigation link that looks like a button (keeps link semantics for assistive tech). */
export function LinkButton({
  className,
  variant,
  size,
  ...props
}: ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
