'use client';

import { Button } from '@/components/ui/button';

export default function SharedMeetingError({ retry }: { retry: () => void }) {
  return (
    <main className="mx-auto grid max-w-3xl gap-3 px-5 py-10">
      <h1 className="text-2xl font-semibold">Could not load the shared meeting</h1>
      <Button className="justify-self-start" onClick={retry}>
        Try again
      </Button>
    </main>
  );
}
