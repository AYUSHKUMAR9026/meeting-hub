import { readFile } from 'node:fs/promises';

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

test('sign up → verify → workspace → invite → accept → upload → review → export → share → revoke → delete', async ({
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

  // 9. The fake transcript labels both speakers and selecting a segment seeks the audio.
  const summary = ownerPage.getByTestId('summary-panel');
  await expect(summary.getByTestId('decision').getByRole('heading')).toHaveText(
    'Review the agenda',
  );
  const action = summary.getByTestId('action-item');
  await expect(action.getByRole('heading')).toHaveText('Share next steps');
  await audio.evaluate((element: HTMLAudioElement) => element.pause());
  await action.getByRole('button', { name: /Open evidence at/ }).click();
  const cited = ownerPage.getByTestId('transcript-segment').first();
  await expect(cited).toBeFocused();
  const citedStart = Number(await cited.getAttribute('data-start-ms')) / 1000;
  expect(citedStart).toBeGreaterThan(0);
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeCloseTo(citedStart, 1);
  await ownerPage.getByRole('button', { name: 'Transcript', exact: true }).click();
  const transcript = ownerPage.getByTestId('transcript-panel');
  const segments = transcript.getByRole('list', { name: 'Transcript segments' });
  await expect(segments.getByText('Speaker A', { exact: true })).toBeVisible();
  await expect(segments.getByText('Speaker B', { exact: true })).toBeVisible();
  const cue = transcript.getByTestId('transcript-segment').nth(1);
  const start = Number(await cue.getAttribute('data-start-ms')) / 1000;
  expect(start).toBeGreaterThan(0);
  await audio.evaluate((el: HTMLAudioElement) => el.pause());
  await cue.click();
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeCloseTo(start, 1);
  await expect(cue).toHaveAttribute('aria-current', 'true');
  const waveform = ownerPage.getByRole('img', { name: 'Audio waveform' });
  await expect(waveform).toBeVisible();
  await expect
    .poll(() =>
      waveform.evaluate((canvas: HTMLCanvasElement) =>
        canvas
          .getContext('2d')
          ?.getImageData(0, 0, canvas.width, canvas.height)
          .data.some((alpha, index) => index % 4 === 3 && alpha > 0),
      ),
    )
    .toBe(true);
  await transcript.getByRole('searchbox', { name: 'Search transcript' }).fill('agenda');
  await transcript.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(transcript.getByTestId('transcript-segment')).toHaveCount(1);
  await expect(transcript.getByTestId('transcript-segment')).toContainText('agenda');
  await transcript.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(transcript.getByTestId('transcript-segment')).toHaveCount(2);

  // 10. Download the document and share it with a signed-out visitor.
  const downloadEvent = ownerPage.waitForEvent('download');
  await ownerPage.getByRole('button', { name: 'Export Markdown' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  await expect(readFile(await download.path(), 'utf8')).resolves.toContain('Review the agenda');
  await ownerPage.getByRole('button', { name: 'Create share link' }).click();
  const link = ownerPage.getByRole('textbox', { name: 'New share link' });
  await expect(link).toBeVisible();
  const publicPage = await newPage(browser);
  const shareResponse = await publicPage.goto(await link.inputValue());
  expect(shareResponse?.status()).toBe(200);
  expect(shareResponse?.headers()['x-robots-tag']).toContain('noindex');
  await expect(publicPage.getByRole('heading', { name: 'Review the agenda' })).toBeVisible();
  await expect(publicPage.getByRole('heading', { name: 'Transcript', exact: true })).toHaveCount(0);
  await ownerPage.getByRole('button', { name: 'Revoke share link' }).click();
  await expect(ownerPage.getByText(/^Revoked/)).toBeVisible();
  const revoked = await publicPage.reload();
  expect(revoked?.status()).toBe(404);
  await expect(publicPage.getByRole('heading', { name: 'Shared meeting not found' })).toBeVisible();
  await publicPage.context().close();

  // 11. Review across the workspace, then jump back to the dated evidence.
  await ownerPage.getByRole('link', { name: 'Decisions', exact: true }).click();
  const trackedDecision = ownerPage
    .getByRole('listitem')
    .filter({ has: ownerPage.getByRole('heading', { name: 'Review the agenda' }) });
  await trackedDecision.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(trackedDecision.getByText('confirmed', { exact: true })).toBeVisible();
  await ownerPage.getByRole('link', { name: 'Action items', exact: true }).click();
  const trackedAction = ownerPage
    .getByRole('listitem')
    .filter({ has: ownerPage.getByRole('heading', { name: 'Share next steps' }) });
  await trackedAction.getByRole('button', { name: 'Mark done' }).click();
  await expect(trackedAction.getByText('done', { exact: true })).toBeVisible();
  await trackedAction.getByRole('link', { name: 'Evidence at', exact: false }).click();
  await expect(ownerPage.getByTestId('transcript-segment').first()).toBeFocused();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeCloseTo(citedStart, 1);

  // 12. Delete it: gone from the list right away (storage is purged by the worker's job).
  await ownerPage.getByRole('button', { name: 'Delete' }).click();
  await ownerPage.getByRole('button', { name: 'Delete meeting' }).click();
  await expect(ownerPage).toHaveURL(/\/meetings$/);
  await expect(ownerPage.getByText('No meetings yet')).toBeVisible();
});
