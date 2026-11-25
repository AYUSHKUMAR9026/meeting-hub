import {
  AccessToken,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  DirectFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  WebhookReceiver,
  type WebhookEvent,
} from 'livekit-server-sdk';
import type { Config } from '../../lib/config';
import { randomBytes, randomUUID } from 'node:crypto';

export interface JoinGrant {
  room: string;
  userId: string;
  displayName: string;
  recordingEnabled: boolean;
  consentAcknowledged: boolean;
}

export interface RoomProvider {
  createRoom(name: string): Promise<void>;
  mintJoinToken(grant: JoinGrant): Promise<string>;
  endRoom(name: string): Promise<void>;
  startRecording(room: string, storageKey: string, trackId?: string): Promise<string>;
  stopRecording(egressId: string): Promise<void>;
  handleWebhook(body: string, authorization: string): Promise<WebhookEvent>;
  roomExists(name: string): Promise<boolean>;
  listRooms(): Promise<string[]>;
  recordingState(id: string): Promise<'active' | 'done' | 'failed'>;
  recordingStartedAt(id: string): Promise<Date | null>;
}

export class LiveKitProvider implements RoomProvider {
  private readonly service: RoomServiceClient;
  private readonly egress: EgressClient;
  private readonly receiver: WebhookReceiver;

  constructor(private readonly config: Config) {
    const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = config;
    if (!key || !secret) throw new Error('Missing live room credentials');
    this.service = new RoomServiceClient(url, key, secret);
    this.egress = new EgressClient(url, key, secret);
    this.receiver = new WebhookReceiver(key, secret);
  }

  async createRoom(name: string) {
    await this.service.createRoom({
      name,
      maxParticipants: this.config.ROOM_MAX_PARTICIPANTS,
      emptyTimeout: this.config.ROOM_EMPTY_TIMEOUT_SECONDS,
      departureTimeout: this.config.ROOM_EMPTY_TIMEOUT_SECONDS,
    });
  }

  async mintJoinToken(grant: JoinGrant) {
    const token = new AccessToken(this.config.LIVEKIT_API_KEY, this.config.LIVEKIT_API_SECRET, {
      identity: grant.userId,
      name: grant.displayName,
      ttl: '2m',
    });
    token.addGrant({
      room: grant.room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: !grant.recordingEnabled || grant.consentAcknowledged,
      canPublishData: true,
    });
    return token.toJwt();
  }

  async endRoom(name: string) {
    await this.service.deleteRoom(name);
  }

  async roomExists(name: string) {
    return (await this.service.listRooms([name])).length > 0;
  }
  async listRooms() {
    return (await this.service.listRooms()).map((room) => room.name);
  }
  async recordingState(id: string) {
    const [info] = await this.egress.listEgress({ egressId: id });
    if (!info || info.status >= EgressStatus.EGRESS_FAILED) return 'failed' as const;
    return info.status === EgressStatus.EGRESS_COMPLETE ? ('done' as const) : ('active' as const);
  }
  async recordingStartedAt(id: string) {
    const [info] = await this.egress.listEgress({ egressId: id });
    const started = info?.fileResults[0]?.startedAt;
    return started && started > 0n ? new Date(Number(started / 1000000n)) : null;
  }

  async startRecording(room: string, storageKey: string, trackId?: string) {
    const c = this.config;
    const file = new EncodedFileOutput({
      filepath: storageKey + '.ogg',
      fileType: EncodedFileType.OGG,
      disableManifest: true,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: c.S3_ACCESS_KEY_ID,
          secret: c.S3_SECRET_ACCESS_KEY,
          bucket: c.S3_BUCKET,
          region: c.S3_REGION,
          endpoint: c.LIVEKIT_EGRESS_S3_ENDPOINT ?? c.S3_ENDPOINT,
          forcePathStyle: c.S3_FORCE_PATH_STYLE,
        }),
      },
    });
    const info = trackId
      ? await this.egress.startTrackEgress(
          room,
          new DirectFileOutput({
            filepath: file.filepath,
            disableManifest: true,
            output: file.output,
          }),
          trackId,
        )
      : await this.egress.startRoomCompositeEgress(room, file, { audioOnly: true });
    return info.egressId;
  }

  async stopRecording(id: string) {
    await this.egress.stopEgress(id);
  }

  async handleWebhook(body: string, authorization: string) {
    const event = await this.receiver.receive(body, authorization);
    const age = Date.now() / 1000 - Number(event.createdAt);
    if (!event.id || age < -30 || age > 300) throw new Error('Stale room event');
    return event;
  }
}

export class FakeRoomProvider implements RoomProvider {
  recordingStartedAt() {
    return Promise.resolve(null);
  }
  private readonly rooms = new Set<string>();
  private readonly recordings = new Map<string, string>();
  private readonly signingKey = randomBytes(32).toString('hex');
  createRoom(name: string) {
    this.rooms.add(name);
    return Promise.resolve();
  }
  endRoom(name: string) {
    this.rooms.delete(name);
    return Promise.resolve();
  }
  roomExists(name: string) {
    return Promise.resolve(this.rooms.has(name));
  }
  listRooms() {
    return Promise.resolve([...this.rooms]);
  }
  async mintJoinToken(grant: JoinGrant) {
    const token = new AccessToken('fake', this.signingKey, {
      identity: grant.userId,
      name: grant.displayName,
      ttl: '2m',
    });
    token.addGrant({
      room: grant.room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: !grant.recordingEnabled || grant.consentAcknowledged,
      canPublishData: true,
    });
    return token.toJwt();
  }
  startRecording(room: string) {
    const id = randomUUID();
    this.recordings.set(id, room);
    return Promise.resolve(id);
  }
  stopRecording(id: string) {
    this.recordings.delete(id);
    return Promise.resolve();
  }
  recordingState(id: string) {
    return Promise.resolve(
      this.rooms.has(this.recordings.get(id) ?? '') ? ('active' as const) : ('done' as const),
    );
  }
  handleWebhook(): Promise<WebhookEvent> {
    return Promise.reject(new Error('Fake provider does not accept external events'));
  }
}
