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
test('two consented browsers record audio and produce a cited document', async ({ browser }) => {
  test.setTimeout(300000);
  const stamp = Date.now().toString(36);
  const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const email = `room-guest-${stamp}@e2e.test`;
  await register(host, 'Room Host', `room-host-${stamp}@e2e.test`);
  const headers = { origin: 'http://localhost:3000' };
  const created = await host.request.post('/v1/workspaces', {
    headers,
    data: { name: 'Room ' + stamp },
  });
  expect(created.ok()).toBeTruthy();
  const workspace = (await created.json()) as { id: string; slug: string };
  await host.request.post('/v1/workspaces/' + workspace.id + '/invitations', {
    headers,
    data: { email, role: 'admin' },
  });
  const invitation = await linkFromEmail(email, 'invited you');
  await register(guest, 'Room Guest', email);
  const invitationId = new URL(invitation).pathname.split('/').pop()!;
  const accepted = await guest.request.post('/v1/invitations/' + invitationId + '/accept', {
    headers,
  });
  expect(accepted.ok()).toBeTruthy();
  const response = await host.request.post(`/v1/workspaces/${workspace.id}/meetings`, {
    headers: { origin: 'http://localhost:3000' },
    data: { title: 'Live room test', occurredAt: new Date().toISOString(), participantIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const meeting = (await response.json()) as { id: string };
  const path = `/w/${workspace.slug}/m/${meeting.id}`;
  await host.goto(path);
  await host.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await host.getByRole('link', { name: 'Join meeting' }).click();
  await expect(host.getByRole('heading', { name: 'Meeting room', exact: true })).toBeVisible({
    timeout: 60000,
  });
  await guest.goto(path + '/room');
  await expect(guest.getByRole('heading', { name: 'Meeting room', exact: true })).toBeVisible({
    timeout: 60000,
  });
  await expect(guest.getByRole('button', { name: 'Join room' })).toHaveCount(0);
  await host.getByRole('checkbox', { name: 'I acknowledge' }).check();
  await host.getByRole('button', { name: 'Join room' }).click();
  await expect(host.locator('.lk-video-conference')).toBeVisible();
  await guest.getByRole('checkbox', { name: 'I acknowledge' }).check();
  await guest.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.locator('.lk-video-conference')).toBeVisible();
  await expect(host.locator('.lk-participant-tile')).toHaveCount(2);
  await expect(host.locator('.lk-participant-tile[data-lk-audio-muted="false"]')).toHaveCount(2);
  await expect
    .poll(
      () =>
        host
          .locator('audio')
          .evaluateAll((elements) =>
            elements.some(
              (element) => element instanceof HTMLMediaElement && element.currentTime > 5,
            ),
          ),
      { timeout: 30000 },
    )
    .toBe(true);
  await host.getByRole('button', { name: 'End for everyone' }).click();
  await expect(host).toHaveURL(path, { timeout: 60000 });
  await expect(guest).toHaveURL(path, { timeout: 60000 });
  await expect(host.getByTestId('meeting-status')).toHaveText('Ready', { timeout: 120000 });
  const summary = host.getByTestId('summary-panel');
  await expect(summary.getByTestId('decision').getByRole('heading')).toHaveText(
    'Review the agenda',
  );
  await summary
    .getByTestId('action-item')
    .getByRole('button', { name: /Open evidence at/ })
    .click();
  await expect(host.getByTestId('transcript-segment').first()).toBeFocused();
  await expect(host.getByTestId('transcript-panel')).toContainText('agenda');
  await host.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(host.getByTestId('transcript-panel')).toContainText('Room Host');
  await expect(host.getByTestId('transcript-panel')).toContainText('Room Guest');
  await hostContext.close();
  await guestContext.close();
});
