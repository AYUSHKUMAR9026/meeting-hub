'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField } from '@/components/app/form-field';
import { useWorkspace } from '@/components/app/workspace-context';
import { ConsentCheckbox } from '@/components/meetings/consent-checkbox';
import { FileDropZone, type SelectedRecording } from '@/components/meetings/file-drop-zone';
import { ParticipantsPicker, type PickedPerson } from '@/components/meetings/participants-picker';
import { UploadProgressView } from '@/components/meetings/upload-progress';
import { useMeetingPermissions } from '@/components/meetings/use-meeting-permissions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useRecordingUpload } from '@/hooks/use-recording-upload';
import { api, problemMessage } from '@/lib/api/client';
import { utcToZonedLocal, zonedLocalToUtc } from '@/lib/time-zone';

export default function NewMeetingPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const { canCreate, uploadsEnabled } = useMeetingPermissions(null);
  const tz = workspace.settings.timezone;
  const upload = useRecordingUpload();

  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(() => utcToZonedLocal(new Date(), tz));
  const [participants, setParticipants] = useState<PickedPerson[]>([]);
  const [recording, setRecording] = useState<SelectedRecording | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Created on the first submit; a retry after a failed upload reuses it instead of duplicating.
  const [meetingId, setMeetingId] = useState<string | null>(null);

  const meetingUrl = (id: string) => `/w/${workspace.slug}/m/${id}`;
  const uploading = upload.state.phase === 'uploading' || upload.state.phase === 'failed';
  const locked = submitting || uploading;

  if (!canCreate) {
    return <p className="text-sm text-muted-foreground">Your role can&apos;t create meetings.</p>;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (recording && !consent) {
      setError('Confirm that everyone agreed to be recorded before uploading.');
      return;
    }
    setSubmitting(true);
    let id = meetingId;
    if (!id) {
      const { data, error: apiError } = await api.POST('/v1/workspaces/{wid}/meetings', {
        params: { path: { wid: workspace.id } },
        body: {
          title,
          occurredAt: zonedLocalToUtc(when, tz).toISOString(),
          participantIds: participants.map((p) => p.id),
        },
      });
      if (!data) {
        setSubmitting(false);
        setError(problemMessage(apiError, 'Could not create the meeting.'));
        return;
      }
      id = data.id;
      setMeetingId(id);
    }
    if (!recording) {
      toast.success('Meeting created');
      router.push(meetingUrl(id));
      return;
    }
    const uploaded = await upload.start(id, recording.file, recording.contentType);
    setSubmitting(false);
    if (uploaded) {
      toast.success('Recording uploaded');
      router.push(meetingUrl(id));
    }
  }

  async function onResume() {
    if (meetingId && (await upload.resume())) {
      toast.success('Recording uploaded');
      router.push(meetingUrl(meetingId));
    }
  }

  async function onCancel() {
    await upload.cancel();
    // The meeting exists (without a recording); continue there.
    if (meetingId) router.push(meetingUrl(meetingId));
  }

  return (
    <div className="grid gap-6">
      <div>
        <Link
          href={`/w/${workspace.slug}/meetings`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Meetings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New meeting</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>Times are in the workspace time zone ({tz}).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="grid gap-5">
            <FormField
              id="title"
              label="Title"
              required
              maxLength={200}
              value={title}
              disabled={locked || meetingId !== null}
              onChange={(e) => setTitle(e.target.value)}
            />
            <FormField
              id="occurredAt"
              label="Date and time"
              type="datetime-local"
              required
              value={when}
              disabled={locked || meetingId !== null}
              onChange={(e) => setWhen(e.target.value)}
            />
            <div className="grid gap-1.5">
              <Label>Participants</Label>
              <ParticipantsPicker
                value={participants}
                onChange={setParticipants}
                disabled={locked || meetingId !== null}
              />
            </div>
            {uploadsEnabled && (
              <div className="grid gap-3">
                <Label>Recording</Label>
                <FileDropZone value={recording} onChange={setRecording} disabled={locked} />
                {recording && (
                  <ConsentCheckbox checked={consent} onChange={setConsent} disabled={locked} />
                )}
              </div>
            )}
            <FormError message={error} />
            {uploading ? (
              <UploadProgressView
                state={upload.state}
                onCancel={() => void onCancel()}
                onResume={() => void onResume()}
              />
            ) : (
              <Button type="submit" className="justify-self-start" disabled={locked}>
                {recording ? 'Create and upload' : 'Create meeting'}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
