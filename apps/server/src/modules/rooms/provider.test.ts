import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { FakeRoomProvider, LiveKitProvider } from './provider';
import { configSchema } from '../../lib/config';

const decodeJwt = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

describe('room token consent', () => {
  it('scopes short-lived tokens to the user and room and blocks publishing before consent', async () => {
    const provider = new FakeRoomProvider();
    const grant = {
      room: 'specific-room',
      userId: 'specific-user',
      displayName: 'Member',
      recordingEnabled: true,
      consentAcknowledged: false,
    };
    const claims = decodeJwt(await provider.mintJoinToken(grant));
    expect(claims.sub).toBe(grant.userId);
    expect(claims.video).toMatchObject({
      room: grant.room,
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
    });
    expect(Number(claims.exp) - Number(claims.nbf)).toBeLessThanOrEqual(120);
    expect(
      decodeJwt(await provider.mintJoinToken({ ...grant, consentAcknowledged: true })).video,
    ).toMatchObject({ canPublish: true });
    expect(
      decodeJwt(await provider.mintJoinToken({ ...grant, recordingEnabled: false })).video,
    ).toMatchObject({ canPublish: true });
  });
  it('rejects unsigned webhooks', async () => {
    const cfg = configSchema.parse({
      DATABASE_URL: 'postgres://u:p@localhost/db',
      REDIS_URL: 'redis://localhost',
      WEB_ORIGIN: 'http://localhost:3000',
      S3_REGION: 'local',
      S3_BUCKET: 'local',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      SMTP_HOST: 'localhost',
      LIVEKIT_API_KEY: 'test',
      LIVEKIT_API_SECRET: 'b'.repeat(32),
    });
    await expect(new LiveKitProvider(cfg).handleWebhook('{}', '')).rejects.toThrow();
    const body = JSON.stringify({
      id: randomUUID(),
      event: 'room_started',
      createdAt: Math.floor(Date.now() / 1000),
    });
    const token = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, { ttl: '1m' });
    token.sha256 = createHash('sha256').update(body).digest('base64');
    const signature = await token.toJwt();
    expect((await new LiveKitProvider(cfg).handleWebhook(body, signature)).event).toBe(
      'room_started',
    );
    await expect(new LiveKitProvider(cfg).handleWebhook(body + ' ', signature)).rejects.toThrow();
    for (const offset of [-600, 120]) {
      const stale = JSON.stringify({
        id: randomUUID(),
        event: 'room_started',
        createdAt: Math.floor(Date.now() / 1000) + offset,
      });
      const signed = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, { ttl: '1m' });
      signed.sha256 = createHash('sha256').update(stale).digest('base64');
      await expect(
        new LiveKitProvider(cfg).handleWebhook(stale, await signed.toJwt()),
      ).rejects.toThrow('Stale room event');
    }
    const provider = new LiveKitProvider(cfg);
    for (const consentAcknowledged of [false, true]) {
      const claims = decodeJwt(
        await provider.mintJoinToken({
          room: 'room',
          userId: 'user',
          displayName: 'Member',
          recordingEnabled: true,
          consentAcknowledged,
        }),
      );
      expect(claims.video).toMatchObject({ room: 'room', canPublish: consentAcknowledged });
    }
  });
});
