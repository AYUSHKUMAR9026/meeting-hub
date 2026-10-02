import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Meeting Hub</h1>
      <p className="text-muted-foreground">Phase 1 foundation is running.</p>
      <Link href="/status" className="underline underline-offset-4">
        View system status →
      </Link>
    </main>
  );
}
