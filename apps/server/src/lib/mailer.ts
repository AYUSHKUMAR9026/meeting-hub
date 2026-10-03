import nodemailer, { type Transporter } from 'nodemailer';

import type { Config } from './config';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body; always sent. */
  text: string;
  html?: string;
}

/** Outgoing email. SMTP today (Mailpit locally); a production provider comes later. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close(): void;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(
    config: Pick<
      Config,
      'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'MAIL_FROM'
    >,
  ) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
    });
    this.from = config.MAIL_FROM;
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }

  close(): void {
    this.transport.close();
  }
}

/** Keeps messages in memory. For tests. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): void {}

  /** Most recent message to `to`, or undefined. */
  lastTo(to: string): MailMessage | undefined {
    return this.sent.findLast((m) => m.to === to);
  }
}
