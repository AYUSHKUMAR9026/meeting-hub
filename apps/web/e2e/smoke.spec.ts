import { type Browser, expect, type Page, test } from '@playwright/test';

import { WAV_SAMPLE_RATE, wavFixture } from './fixtures';
import { linkFromEmail } from './mailpit';

// Test-only credentials for throwaway local/CI accounts.
const PASSWORD = 'e2e-password-not-secret';
const run = Date.now().toString(36);
const owner = { name: 'Olive Owner', email: `owner-${run}@e2e.test` };
const invitee = { name: 'Ian Invitee', email: `invitee-${run}@e2e.test` };
const workspaceName = `E2E Workspace ${run}`;

// ~11 MiB of 16-bit mono PCM: about 131 s of audio.
const wavBytes = 11 * 1024 * 1024;
const wavSeconds = (wavBytes - 44) / 2 / WAV_SAMPLE_RATE;
const formatSeconds = (s: number) =>
  `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;

async function signUp(page: Page, user: { name: string; email: string }) {
  await page.getByLabel('Name').fill(user.name);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(`We sent a verification link to ${user.email}`)).toBeVisible();
}

/** Opens the emailed verification link; Better Auth verifies and signs the user in. */
async function verifyViaMailpit(page: Page, email: string) {
  await page.goto(await linkFromEmail(email, 'Verify your email'));
  await expect(page.getByText("Your email is verified and you're signed in.")).toBeVisible();
  await page.getByRole('link', { name: 'Continue' }).click();
}

async function newPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

test('sign up → verify → workspace → invite → accept → upload → live processing → play → delete', async ({
  browser,
}) => {
  // 1. Owner signs up and verifies their email via Mailpit.
  const ownerPage = await newPage(browser);
  await ownerPage.goto('/sign-up');
  await signUp(ownerPage, owner);
  await verifyViaMailpit(ownerPage, owner.email);

  // 2. No workspace yet → onboarding → create one.
  await expect(ownerPage).toHaveURL(/\/onboarding$/);
  await ownerPage.getByLabel('Workspace name').fill(workspaceName);
  await ownerPage.getByRole('button', { name: 'Create workspace' }).click();
  await expect(ownerPage).toHaveURL(/\/w\/e2e-workspace-/);
  await expect(ownerPage.getByRole('heading', { name: workspaceName })).toBeVisible();
  await expect(ownerPage.getByTestId('my-role')).toHaveText('owner');

  // 3. Invite the second user as a member.
  await ownerPage.getByRole('link', { name: 'Settings' }).click();
  await ownerPage.getByRole('link', { name: 'Members' }).click();
  await ownerPage.getByLabel('Email', { exact: true }).fill(invitee.email);
  await ownerPage.getByLabel('Role', { exact: true }).selectOption('member');
  await ownerPage.getByRole('button', { name: 'Send invitation' }).click();
  await expect(ownerPage.getByRole('cell', { name: invitee.email })).toBeVisible();

  // 4. The invitee opens the emailed link signed out → signs up → verifies → lands back on it.
  const inviteLink = await linkFromEmail(invitee.email, 'invited you');
  const inviteePage = await newPage(browser);
  await inviteePage.goto(inviteLink);
  await expect(inviteePage).toHaveURL(/\/sign-in\?returnTo=%2Faccept-invitation%2F/);
  await inviteePage.getByRole('link', { name: 'Create an account' }).click();
  await signUp(inviteePage, invitee);
  await verifyViaMailpit(inviteePage, invitee.email);

  // 5. Accept and see the workspace with the invited role.
  await expect(inviteePage).toHaveURL(/\/accept-invitation\//);
  await expect(inviteePage.getByText(`join ${workspaceName} as member`)).toBeVisible();
  await inviteePage.getByRole('button', { name: `Join ${workspaceName}` }).click();
  await expect(inviteePage.getByRole('heading', { name: workspaceName })).toBeVisible();
  await expect(inviteePage.getByTestId('my-role')).toHaveText('member');

  // The owner now sees them as a member.
  await ownerPage.reload();
  await expect(ownerPage.getByTestId(`member-${invitee.email}`)).toContainText('member');

  // 6. Create a meeting with the invitee as participant and upload a recording straight to
  //    storage (~11 MiB → 3 parts of 5 MiB when the API runs with UPLOAD_PART_SIZE_BYTES=5 MiB).
  const meetingTitle = `E2E sync ${run}`;
  await ownerPage.getByRole('link', { name: 'Meetings' }).click();
  await ownerPage.getByRole('link', { name: 'New meeting' }).first().click();
  await ownerPage.getByLabel('Title').fill(meetingTitle);
  await ownerPage.getByRole('checkbox', { name: new RegExp(invitee.name) }).check();
  await ownerPage.getByLabel('Recording file').setInputFiles({
    name: 'e2e-sync.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(wavBytes),
  });
  await expect(ownerPage.getByTestId('selected-file')).toContainText('e2e-sync.wav');
  await ownerPage.getByRole('checkbox', { name: /agreed to be recorded/ }).check();
  await ownerPage.getByRole('button', { name: 'Create and upload' }).click();

  await expect(ownerPage).toHaveURL(/\/m\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(ownerPage.getByRole('heading', { name: meetingTitle })).toBeVisible();
  await expect(ownerPage.getByTestId('recording-card')).toContainText('e2e-sync.wav');
  await expect(ownerPage.getByLabel('Participants')).toContainText(invitee.name);

  // 7. Processing starts by itself (outbox → worker) and the page follows it live, without a
  //    reload: the panel and its progress bar appear, then the meeting becomes Ready.
  const panel = ownerPage.getByTestId('processing-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('progressbar', { name: 'Processing progress' })).toBeVisible();
  await expect(ownerPage.getByTestId('meeting-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(panel).toHaveAttribute('data-run-status', 'completed');
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

  // 8. The processed audio plays in the browser and reports the recording's duration.
  const audio = ownerPage.getByTestId('meeting-audio');
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration), { timeout: 30_000 })
    .toBeGreaterThan(wavSeconds - 1);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeLessThan(wavSeconds + 1);
  await expect(ownerPage.getByTestId('audio-duration')).toHaveText(formatSeconds(wavSeconds));
  await audio.evaluate((el: HTMLAudioElement) => {
    el.muted = true;
    return el.play();
  });
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(0.2);

  // 9. Delete it: gone from the list right away (storage is purged by the worker's job).
  await ownerPage.getByRole('button', { name: 'Delete' }).click();
  await ownerPage.getByRole('button', { name: 'Delete meeting' }).click();
  await expect(ownerPage).toHaveURL(/\/meetings$/);
  await expect(ownerPage.getByText('No meetings yet')).toBeVisible();
});
