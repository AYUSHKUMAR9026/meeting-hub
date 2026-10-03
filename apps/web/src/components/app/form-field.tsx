import type { ComponentProps, ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Label + input pair with an optional hint. */
export function FormField({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: ReactNode } & ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...input} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** Native select styled like the shadcn input (keyboard- and test-friendly). */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={`h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${className ?? ''}`}
      {...props}
    />
  );
}
