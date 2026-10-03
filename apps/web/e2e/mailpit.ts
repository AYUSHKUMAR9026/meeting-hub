import { expect } from '@playwright/test';

/** Mailpit's HTTP API (the UI port). Override when 8025 is taken locally. */
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface MessageSummary {
  ID: string;
  Subject: string;
}

/** Waits for the newest email to `to` whose subject contains `subject`; returns its first link. */
export async function linkFromEmail(to: string, subject: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        const query = encodeURIComponent(`to:"${to}" subject:"${subject}"`);
        const search = (await (
          await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
        ).json()) as { messages: MessageSummary[] };
        const newest = search.messages[0];
        if (!newest) return '';
        const message = (await (
          await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`)
        ).json()) as { Text: string };
        link = /https?:\/\/\S+/.exec(message.Text)?.[0] ?? '';
        return link;
      },
      { message: `email "${subject}" to ${to}`, timeout: 30_000 },
    )
    .not.toBe('');
  return link;
}
