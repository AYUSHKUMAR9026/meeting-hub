'use client';

import { DownloadIcon, FileAudioIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField } from '@/components/app/form-field';
import { useWorkspace } from '@/components/app/workspace-context';
import { MeetingStatusBadge } from '@/components/meetings/meeting-status-badge';
import { ParticipantsPicker, type PickedPerson } from '@/components/meetings/participants-picker';
import { RecordingUploadCard } from '@/components/meetings/recording-upload-card';
import { useMeetingPermissions } from '@/components/meetings/use-meeting-permissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, type Meeting, problemMessage } from '@/lib/api/client';
import { formatInZone, utcToZonedLocal, zonedLocalToUtc } from '@/lib/time-zone';
import { formatBytes } from '@/lib/upload/progress';

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace();
  const meeting = useApiQuery(`meeting:${id}`, () =>
    api.GET('/v1/meetings/{id}', { params: { path: { id } } }),
  );

  if (meeting.state.status === 'loading') {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (meeting.state.status === 'error') {
    return meeting.state.httpStatus === 404 ? (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Meeting not found</h1>
        <p className="text-sm text-muted-foreground">
          It may have been deleted.{' '}
          <Link href={`/w/${workspace.slug}/meetings`} className="underline underline-offset-4">
            Back to meetings
          </Link>
        </p>
      </div>
    ) : (
      <FormError message={problemMessage(meeting.state.error, 'Could not load the meeting.')} />
    );
  }
  return <MeetingDetail meeting={meeting.state.data} onChanged={meeting.reload} />;
}

function MeetingDetail({ meeting, onChanged }: { meeting: Meeting; onChanged: () => void }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const perms = useMeetingPermissions(meeting);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const tz = workspace.settings.timezone;
  const recording = meeting.recording;

  async function remove() {
    setDeleting(true);
    const { error } = await api.DELETE('/v1/meetings/{id}', {
      params: { path: { id: meeting.id } },
    });
    if (error) {
      setDeleting(false);
      toast.error(problemMessage(error, 'Could not delete the meeting.'));
      return;
    }
    toast.success('Meeting deleted');
    router.push(`/w/${workspace.slug}/meetings`);
  }

  async function download() {
    const { data, error } = await api.GET('/v1/meetings/{id}/recording', {
      params: { path: { id: meeting.id } },
    });
    if (!data) {
      toast.error(problemMessage(error, 'Could not get a download link.'));
      return;
    }
    window.location.assign(data.downloadUrl); // served as an attachment, never inline
  }

  async function cancelStaleUpload() {
    if (!recording) return;
    const { error } = await api.DELETE('/v1/meetings/{id}/uploads/{uploadId}', {
      params: { path: { id: meeting.id, uploadId: recording.id } },
    });
    if (error) toast.error(problemMessage(error, 'Could not cancel the upload.'));
    onChanged();
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link
          href={`/w/${workspace.slug}/meetings`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Meetings
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{meeting.title}</h1>
          <MeetingStatusBadge status={meeting.status} />
          <div className="ml-auto flex gap-2">
            {perms.canEdit && !editing && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {perms.canDelete && !confirmDelete && (
              <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{formatInZone(meeting.occurredAt, tz)}</p>
        <div className="flex flex-wrap gap-1.5" aria-label="Participants">
          {meeting.participants.length ? (
            meeting.participants.map((p) => (
              <Badge key={p.id} variant="secondary">
                {p.displayName}
              </Badge>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">No participants listed</span>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Card className="border-destructive/40" role="alertdialog" aria-label="Confirm deletion">
          <CardHeader>
            <CardTitle>Delete this meeting?</CardTitle>
            <CardDescription>
              The meeting and its recording are removed for everyone. This can&apos;t be undone.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant="destructive" disabled={deleting} onClick={() => void remove()}>
              {deleting ? 'Deleting…' : 'Delete meeting'}
            </Button>
            <Button variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {editing && (
        <EditMeetingCard
          meeting={meeting}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}

      {recording && recording.status !== 'failed' && (
        <Card data-testid="recording-card">
          <CardHeader>
            <CardTitle>Recording</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <FileAudioIcon className="size-5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{recording.fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(recording.sizeBytes)} · {recording.contentType}
                </p>
              </div>
              <Badge variant={recording.status === 'uploaded' ? 'default' : 'secondary'}>
                {recording.status === 'uploaded' ? 'Uploaded' : 'Upload in progress'}
              </Badge>
              {perms.canDownload && recording.status === 'uploaded' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => void download()}
                >
                  <DownloadIcon /> Download original
                </Button>
              )}
            </div>
            {recording.status === 'uploaded' && (
              <p className="text-sm text-muted-foreground">
                Processing will be available soon: transcripts, speakers and decisions will appear
                here.
              </p>
            )}
            {recording.status === 'uploading' && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                An upload was started but hasn&apos;t finished. If it was interrupted, cancel it and
                upload again.
                {perms.canUpload && (
                  <Button variant="outline" size="sm" onClick={() => void cancelStaleUpload()}>
                    Cancel upload
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {perms.canUpload && meeting.status === 'awaiting_upload' && (
        <RecordingUploadCard meetingId={meeting.id} onUploaded={onChanged} />
      )}
      {!perms.canUpload && meeting.status === 'awaiting_upload' && (
        <p className="text-sm text-muted-foreground">No recording has been uploaded yet.</p>
      )}
    </div>
  );
}

function EditMeetingCard({ meeting, onDone }: { meeting: Meeting; onDone: () => void }) {
  const workspace = useWorkspace();
  const tz = workspace.settings.timezone;
  const [title, setTitle] = useState(meeting.title);
  const [when, setWhen] = useState(utcToZonedLocal(meeting.occurredAt, tz));
  const [participants, setParticipants] = useState<PickedPerson[]>(meeting.participants);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { error: apiError } = await api.PATCH('/v1/meetings/{id}', {
      params: { path: { id: meeting.id } },
      body: {
        title,
        occurredAt: zonedLocalToUtc(when, tz).toISOString(),
        participantIds: participants.map((p) => p.id),
      },
    });
    if (apiError) {
      setError(problemMessage(apiError, 'Could not save the meeting.'));
      return;
    }
    toast.success('Meeting updated');
    onDone();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit meeting</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="grid gap-4">
          <FormField
            id="edit-title"
            label="Title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <FormField
            id="edit-occurredAt"
            label={`Date and time (${tz})`}
            type="datetime-local"
            required
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
          <div className="grid gap-1.5">
            <Label>Participants</Label>
            <ParticipantsPicker value={participants} onChange={setParticipants} />
          </div>
          <FormError message={error} />
          <div className="flex gap-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
