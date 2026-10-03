'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRecordingUpload } from '@/hooks/use-recording-upload';

import { ConsentCheckbox } from './consent-checkbox';
import { FileDropZone, type SelectedRecording } from './file-drop-zone';
import { UploadProgressView } from './upload-progress';

/** Upload (or retry) the recording of an existing meeting. */
export function RecordingUploadCard({
  meetingId,
  onUploaded,
}: {
  meetingId: string;
  onUploaded: () => void;
}) {
  const upload = useRecordingUpload();
  const [selected, setSelected] = useState<SelectedRecording | null>(null);
  const [consent, setConsent] = useState(false);
  const busy = upload.state.phase === 'uploading' || upload.state.phase === 'failed';

  async function begin() {
    if (!selected) return;
    if (await upload.start(meetingId, selected.file, selected.contentType)) onUploaded();
  }

  async function resume() {
    if (await upload.resume()) onUploaded();
  }

  async function cancel() {
    await upload.cancel();
    upload.reset();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload the recording</CardTitle>
        <CardDescription>
          The file goes straight to secure storage; large files can take a while.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <FileDropZone value={selected} onChange={setSelected} disabled={busy} />
        <ConsentCheckbox checked={consent} onChange={setConsent} disabled={busy} />
        {busy ? (
          <UploadProgressView
            state={upload.state}
            onCancel={() => void cancel()}
            onResume={() => void resume()}
          />
        ) : (
          <Button
            type="button"
            className="justify-self-start"
            disabled={!selected || !consent}
            onClick={() => void begin()}
          >
            Upload recording
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
