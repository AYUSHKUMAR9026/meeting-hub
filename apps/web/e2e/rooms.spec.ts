import { pdfText } from '../../server/test/support/export-readers';
import { test, expect, type Page } from '@playwright/test';
import { linkFromEmail } from './mailpit';

test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
test.skip(process.env.E2E_ROOMS !== '1', 'Optional self-hosted LiveKit test');
async function register(page: Page, name: string, email: string) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('room-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('We sent a verification link', { exact: false })).toBeVisible();
  await page.goto(await linkFromEmail(email, 'Verify your email'));
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/onboarding/);
}
test('member invitation and two-browser live meeting save a dated PDF without audio', async ({
  browser,
}) => {
  test.setTimeout(300000);
  const stamp = Date.now().toString(36);
  const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  try {
    const email = `room-guest-${stamp}@e2e.test`;
    await register(host, 'Room Host', `room-host-${stamp}@e2e.test`);
    const headers = { origin: 'http://localhost:3000' };
    const created = await host.request.post('/v1/workspaces', {
      headers,
      data: { name: 'Room ' + stamp, timezone: 'Asia/Kolkata' },
    });
    expect(created.ok()).toBeTruthy();
    const workspace = (await created.json()) as { id: string; slug: string };
    await host.goto(`/w/${workspace.slug}/meetings/new`);
    await host.getByRole('button', { name: 'Schedule a meeting', exact: true }).click();
    await host.getByLabel('Title', { exact: true }).fill('Live room ' + stamp);
    await host.getByLabel('Date and time', { exact: true }).fill('2026-11-26T15:00');
    await host.getByLabel('Invite by email (comma separated)').fill(email);
    await host.getByRole('checkbox', { name: /agreed to be recorded/ }).check();
    await host.getByRole('button', { name: 'Schedule meeting', exact: true }).click();
    await expect(host).toHaveURL(/\/m\/[0-9a-f-]{36}$/);
    const path = new URL(host.url()).pathname;
    const invitation = await linkFromEmail(email, 'invited you');
    await register(guest, 'Room Guest', email);
    await guest.goto(invitation);
    await expect(guest.getByText('Live room ' + stamp, { exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Join Room ' + stamp, exact: true }).click();
    await host.getByRole('button', { name: 'Start meeting', exact: true }).click();
    await host.getByRole('link', { name: 'Join meeting', exact: true }).click();
    await guest.goto(path + '/room');
    for (const page of [host, guest]) {
      await page.getByRole('checkbox', { name: 'I acknowledge' }).check();
      await page.getByRole('button', { name: 'Join Room', exact: true }).click();
      await expect(page.locator('.lk-video-conference')).toBeVisible();
    }
    await expect(host.locator('.lk-participant-tile')).toHaveCount(2);
    await expect(host.locator('.lk-participant-tile[data-lk-audio-muted="false"]')).toHaveCount(2);
    await expect
      .poll(
        () =>
          host
            .locator('audio')
            .evaluateAll((elements) =>
              elements.some((el) => el instanceof HTMLMediaElement && el.currentTime > 5),
            ),
        { timeout: 30000 },
      )
      .toBe(true);
    await host.getByRole('button', { name: 'End for everyone' }).click();
    await expect(host).toHaveURL(path, { timeout: 60000 });
    await expect(guest).toHaveURL(path, { timeout: 60000 });
    const mediaRequests: string[] = [];
    host.on('request', (request) => {
      if (/\/v1\/meetings\/[^/]+\/(media|recording)(?:\?|$)/.test(request.url()))
        mediaRequests.push(request.url());
    });
    await expect(host.getByTestId('meeting-status')).toHaveText('Ready', { timeout: 180000 });
    await expect(host.getByTestId('decision-pdf')).toBeVisible();
    const response = await host.request.get(
      new URL(
        (await host.getByTestId('decision-pdf').getAttribute('src')) ?? '',
        host.url(),
      ).toString(),
    );
    expect(response.ok()).toBeTruthy();
    expect(await pdfText(await response.body())).toContain('Review the agenda');
    await expect(host.getByTestId('meeting-audio')).toHaveCount(0);
    expect(mediaRequests).toEqual([]);
    await host.goto(`/w/${workspace.slug}/meetings`);
    await expect(
      host.locator('time').filter({ hasText: /Nov.*26.*2026|26.*Nov.*2026/ }),
    ).toBeVisible();
    await expect(host.getByRole('link', { name: 'View PDF', exact: true })).toBeVisible();
  } finally {
    await hostContext.close().catch(() => {});
    await guestContext.close().catch(() => {});
  }
});
