import type { MailMessage } from '../../lib/mailer';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function message(to: string, subject: string, intro: string, action: string, url: string) {
  return {
    to,
    subject,
    text: `${intro}\n\n${action}: ${url}\n\nIf you didn't expect this email, you can ignore it.`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p><p style="color:#666">If you didn't expect this email, you can ignore it.</p>`,
  } satisfies MailMessage;
}

export const verificationEmail = (to: string, url: string) =>
  message(
    to,
    'Verify your email for Meeting Hub',
    'Welcome to Meeting Hub! Confirm this is your email address to finish signing up.',
    'Verify email',
    url,
  );

export const passwordResetEmail = (to: string, url: string) =>
  message(
    to,
    'Reset your Meeting Hub password',
    'Someone (hopefully you) asked to reset your Meeting Hub password. The link expires in 1 hour.',
    'Reset password',
    url,
  );

export const invitationEmail = (
  to: string,
  url: string,
  details: { workspaceName: string; inviterName: string; role: string },
) =>
  message(
    to,
    `${details.inviterName} invited you to ${details.workspaceName} on Meeting Hub`,
    `${details.inviterName} invited you to join the workspace "${details.workspaceName}" as ${details.role}.`,
    'Accept invitation',
    url,
  );
