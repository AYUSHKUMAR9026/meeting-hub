'use client';
import { useState } from 'react';
import { useCan, useWorkspace } from '@/components/app/workspace-context';
import { Button } from '@/components/ui/button';
import { api, problemMessage } from '@/lib/api/client';

export function ContentPurge() {
  const ws = useWorkspace();
  const can = useCan();
  const [kind, setKind] = useState<'recordings' | 'transcripts'>('recordings');
  const [preview, setPreview] = useState<{ count: number; bytes: number }>();
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  if (!can('workspace.purge_content')) return null;
  async function submit(dryRun: boolean) {
    setBusy(true);
    try {
      const r = await api.POST('/v1/workspaces/{wid}/content/purge', {
        params: { path: { wid: ws.id } },
        body: {
          kind,
          dryRun,
          confirmation,
          ...(preview ? { expectedCount: preview.count, expectedBytes: preview.bytes } : {}),
        },
      });
      if (!r.data) setMessage(problemMessage(r.error));
      else if (dryRun) {
        setPreview(r.data);
        setMessage('');
      } else {
        setMessage('Stored content purged. This cannot be undone.');
        setPreview(undefined);
        setConfirmation('');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-3 rounded border p-4">
      <h2 className="font-semibold">Purge stored recordings or transcripts</h2>
      <p>
        Existing data is preserved until you explicitly purge it. This affects every meeting in this
        workspace and cannot be undone. PDFs and extracted items remain, including any transcript
        appendices in earlier PDFs.
      </p>
      <select
        aria-label="Content to purge"
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as typeof kind);
          setPreview(undefined);
          setConfirmation('');
        }}
      >
        <option value="recordings">Recordings</option>
        <option value="transcripts">Transcripts</option>
      </select>
      <Button variant="outline" disabled={busy} onClick={() => void submit(true)}>
        Preview purge
      </Button>
      {preview && (
        <>
          <p>
            {preview.count} {kind}, {preview.bytes.toLocaleString()} bytes will be deleted.
          </p>
          <label>
            Type PURGE {kind.toUpperCase()}
            <input
              className="ml-2 rounded border p-2"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <Button
            variant="destructive"
            disabled={busy || confirmation !== `PURGE ${kind.toUpperCase()}`}
            onClick={() => void submit(false)}
          >
            Purge stored {kind}
          </Button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
