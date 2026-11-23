'use client';

import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField, NativeSelect } from '@/components/app/form-field';
import { useWorkspace } from '@/components/app/workspace-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage, type TranscriptPage } from '@/lib/api/client';

export async function copyDocumentText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Could not copy to the clipboard.');
  }
}

export function MeetingReviewActions({
  meetingId,
  canEdit,
  revision,
}: {
  meetingId: string;
  canEdit: boolean;
  revision: string;
}) {
  const workspace = useWorkspace();
  const exportsEnabled = workspace.features.includes('exports.enabled');
  const sharingEnabled =
    workspace.features.includes('sharing.enabled') && workspace.settings.sharingEnabled;
  if (!exportsEnabled && !(sharingEnabled && canEdit)) return null;
  return (
    <ReviewDownloads
      meetingId={meetingId}
      revision={revision}
      exportsEnabled={exportsEnabled}
      sharingEnabled={Boolean(sharingEnabled && canEdit)}
    />
  );
}

function ReviewDownloads({
  meetingId,
  revision,
  exportsEnabled,
  sharingEnabled,
}: {
  meetingId: string;
  revision: string;
  exportsEnabled: boolean;
  sharingEnabled: boolean;
}) {
  const path = { id: meetingId };
  const doc = useApiQuery(meetingId + ':review-document:' + revision, () =>
    api.GET('/v1/meetings/{id}/document', { params: { path } }),
  );
  const transcript = useApiQuery<TranscriptPage>(
    meetingId + ':review-transcript:' + revision,
    () =>
      exportsEnabled
        ? api.GET('/v1/meetings/{id}/transcript', { params: { path } })
        : Promise.resolve({ response: new Response() }),
  );
  const documentReady = doc.state.status === 'ok' && Boolean(doc.state.data.document);
  const transcriptReady =
    transcript.state.status === 'ok' && Boolean(transcript.state.data.transcript);
  const [appendTranscript, setAppendTranscript] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function download(format: 'md' | 'docx' | 'pdf' | 'txt' | 'srt') {
    const transcript = format === 'txt' || format === 'srt';
    const query = new URLSearchParams({ format });
    if (!transcript && appendTranscript) query.set('include', 'transcript');
    setDownloading(true);
    try {
      const response = await fetch(
        '/v1/meetings/' +
          meetingId +
          (transcript ? '/transcript/export?' : '/export?') +
          query.toString(),
      );
      if (!response.ok) {
        toast.error(problemMessage(await response.json(), 'Could not export the meeting.'));
        return;
      }
      const href = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download =
        response.headers.get('Content-Disposition')?.match(/filename="([A-Za-z0-9_.-]+)"/)?.[1] ??
        'meeting.' + format;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      toast.error('Could not export the meeting.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="grid gap-4 print:hidden">
      {exportsEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>Export</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {!documentReady && (
              <p className="text-sm text-muted-foreground">
                Document exports become available when the summary is ready.
              </p>
            )}
            {documentReady && (
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { label: 'Markdown', format: 'md' },
                    { label: 'Word', format: 'docx' },
                    { label: 'PDF', format: 'pdf' },
                  ] as const
                ).map(({ label, format }) => (
                  <Button
                    key={format}
                    size="sm"
                    variant="outline"
                    disabled={downloading}
                    onClick={() => void download(format)}
                  >
                    Export {label}
                  </Button>
                ))}
                {transcriptReady && (
                  <Label className="ml-1">
                    <input
                      type="checkbox"
                      checked={appendTranscript}
                      onChange={(event) => setAppendTranscript(event.target.checked)}
                    />{' '}
                    Include transcript
                  </Label>
                )}
              </div>
            )}
            {transcriptReady && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={downloading}
                  onClick={() => void download('txt')}
                >
                  Export transcript (TXT)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={downloading}
                  onClick={() => void download('srt')}
                >
                  Export subtitles (SRT)
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {sharingEnabled && <ShareLinks meetingId={meetingId} documentReady={documentReady} />}
    </div>
  );
}

function ShareLinks({ meetingId, documentReady }: { meetingId: string; documentReady: boolean }) {
  const [url, setUrl] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState('');
  const path = { id: meetingId };
  const result = useApiQuery('share-links:' + meetingId, () =>
    api.GET('/v1/meetings/{id}/share-links', { params: { path } }),
  );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError('');
    setUrl(undefined);
    try {
      const { data, error: failure } = await api.POST('/v1/meetings/{id}/share-links', {
        params: { path },
        body: {
          scope:
            form.get('scope') === 'document_and_transcript'
              ? 'document_and_transcript'
              : 'document',
          expiresInDays: Number(form.get('expiresInDays')),
        },
      });
      if (data) {
        setUrl(data.url);
        result.reload();
      } else setError(problemMessage(failure, 'Could not create the share link.'));
    } catch {
      setError('Could not create the share link.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(shareId: string) {
    setRevoking(shareId);
    setError('');
    try {
      const { response, error: failure } = await api.DELETE(
        '/v1/meetings/{id}/share-links/{shareId}',
        { params: { path: { ...path, shareId } } },
      );
      if (response.ok) {
        setUrl(undefined);
        result.reload();
      } else setError(problemMessage(failure, 'Could not revoke the share link.'));
    } catch {
      setError('Could not revoke the share link.');
    } finally {
      setRevoking(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Share links</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {documentReady ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void create(event)}>
            <div className="grid gap-1.5">
              <Label htmlFor="share-scope">Whoever has the link can view</Label>
              <NativeSelect name="scope" id="share-scope" defaultValue="document">
                <option value="document">Document only</option>
                <option value="document_and_transcript">Document and transcript</option>
              </NativeSelect>
            </div>
            <FormField
              type="number"
              label="Expires in days"
              id="expiresInDays"
              min={1}
              max={90}
              defaultValue={1}
              required
            />
            <Button size="sm" type="submit" disabled={creating}>
              Create share link
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            You can create a link when the summary is ready.
          </p>
        )}
        {url && (
          <div className="grid gap-2 rounded-md border p-3">
            <p className="text-sm">Copy this URL now. The full link is shown once.</p>
            <input
              aria-label="New share link"
              readOnly
              value={url}
              className="min-w-0 rounded border bg-background p-2 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => void copyDocumentText(url)}
            >
              Copy link
            </Button>
          </div>
        )}
        {error && <FormError message={error} />}
        {result.state.status === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading share links…
          </p>
        )}
        {result.state.status === 'error' && (
          <FormError message={problemMessage(result.state.error, 'Could not load share links.')} />
        )}
        {result.state.status === 'ok' &&
          (result.state.data.links.length === 0 ? (
            <p className="text-sm text-muted-foreground">No share links yet.</p>
          ) : (
            <ul className="divide-y">
              {result.state.data.links.map((link) => (
                <li
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <div className="text-sm">
                    <p>{link.scope === 'document' ? 'Document only' : 'Document and transcript'}</p>
                    <p className="text-muted-foreground">
                      {link.revokedAt
                        ? 'Revoked'
                        : 'Expires ' + new Date(link.expiresAt).toLocaleDateString()}{' '}
                      · {link.accessCount} views
                    </p>
                  </div>
                  {!link.revokedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(revoking)}
                      onClick={() => void revoke(link.id)}
                    >
                      Revoke share link
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </CardContent>
    </Card>
  );
}
