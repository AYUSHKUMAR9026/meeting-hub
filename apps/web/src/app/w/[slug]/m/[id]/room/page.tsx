'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Room, DisconnectReason } from 'livekit-client';
import { useParams, useRouter } from 'next/navigation';
import {
  LiveKitRoom,
  VideoConference,
  PreJoin,
  type LocalUserChoices,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { api, problemMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/components/app/workspace-context';
import { RoomExtras } from '@/components/meetings/room-extras';
import { AiDisclosure } from '@/components/meetings/ai-disclosure';

export default function RoomPage() {
  const currentUser = useCurrentUser();
  const { id, slug } = useParams<{ id: string; slug: string }>();
  const router = useRouter();
  const [recording, setRecording] = useState(true);
  const [host, setHost] = useState(false);
  const [ack, setAck] = useState(false);
  const [choices, setChoices] = useState<LocalUserChoices>();
  const [join, setJoin] = useState<{ url: string; token: string }>();
  const [error, setError] = useState('');
  const leaving = useRef(false);
  const back = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setJoin(undefined);
    router.replace(`/w/${slug}/m/${id}`);
  }, [router, slug, id]);
  const liveRoom = useMemo(
    () =>
      new Room({
        audioCaptureDefaults: { deviceId: choices?.audioDeviceId },
        videoCaptureDefaults: { deviceId: choices?.videoDeviceId },
      }),
    [choices],
  );
  useEffect(() => {
    const load = async () => {
      const r = await api.GET('/v1/meetings/{id}/room', { params: { path: { id } } });
      if (r.data) {
        setRecording(r.data.recordingEnabled);
        setHost(r.data.canHost);
        if (r.data.recordingStatus === 'failed')
          setError('Recording failed. This call is not being fully saved.');
        if (r.data.status === 'ended') back();
      } else setError(problemMessage(r.error));
    };
    void load().catch(() => setError('Connection interrupted. Reconnecting…'));
    const timer = setInterval(
      () => void load().catch(() => setError('Connection interrupted. Reconnecting…')),
      2000,
    );
    return () => clearInterval(timer);
  }, [id, back]);
  const connect = async (local: LocalUserChoices) => {
    const r = await api.POST('/v1/meetings/{id}/room/join', {
      params: { path: { id } },
      body: { consentAcknowledged: ack },
    });
    if (r.data) {
      setChoices(local);
      setJoin(r.data);
    } else setError(problemMessage(r.error));
  };
  return (
    <main className="grid gap-4">
      <h1>Meeting room</h1>
      <AiDisclosure />
      <p>
        {recording
          ? 'Audio tracks are temporary input for the decision PDF and are deleted after transcription.'
          : 'Recording is off for this meeting.'}
      </p>
      {error && <p role="alert">{error}</p>}
      {!join ? (
        <>
          <label>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
            acknowledge the recording notice
          </label>
          {(!recording || ack) && (
            <PreJoin
              defaults={{ username: currentUser.name, audioEnabled: true, videoEnabled: true }}
              onSubmit={(local) => void connect(local).catch((e) => setError(problemMessage(e)))}
              onError={(e) => setError(e.message)}
            />
          )}
        </>
      ) : (
        <LiveKitRoom
          room={liveRoom}
          serverUrl={join.url}
          token={join.token}
          connect
          audio={choices?.audioEnabled}
          video={choices?.videoEnabled}
          onError={(e) => setError(e.message)}
          onDisconnected={(reason) => {
            if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
              setError('The host removed you from this meeting.');
              setJoin(undefined);
            } else back();
          }}
          data-lk-theme="default"
          style={{ height: '75vh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}
        >
          <RoomExtras meetingId={id} />
          <VideoConference />
        </LiveKitRoom>
      )}
      {host && join && (
        <Button
          variant="destructive"
          onClick={() => {
            void (async () => {
              const r = await api.POST('/v1/meetings/{id}/room/end', { params: { path: { id } } });
              if (r.data) back();
              else setError(problemMessage(r.error));
            })().catch((e) => setError(problemMessage(e)));
          }}
        >
          End for everyone
        </Button>
      )}
    </main>
  );
}
