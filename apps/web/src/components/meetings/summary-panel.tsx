'use client';

import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField, NativeSelect } from '@/components/app/form-field';
import { copyDocumentText } from '@/components/meetings/review-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useApiQuery } from '@/hooks/use-api-query';
import {
  api,
  type DocumentCitation,
  type MeetingActionItem,
  type MeetingDecision,
  problemMessage,
  type TranscriptPage,
} from '@/lib/api/client';
import { formValue } from '@/lib/form';
import { formatDuration } from '@/lib/processing';

type Kind = 'decision' | 'action';
type Item = MeetingDecision | MeetingActionItem;
export type CitationTarget = DocumentCitation & { transcriptId: string };

function ItemForm({
  meetingId,
  transcriptId,
  item,
  kind,
  onDone,
  onCancel,
}: {
  meetingId: string;
  transcriptId: string;
  item?: Item;
  kind: Kind;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const segments = useApiQuery<TranscriptPage>(
    JSON.stringify([meetingId, transcriptId, cursor]),
    () =>
      item
        ? Promise.resolve({ response: new Response() })
        : api.GET('/v1/meetings/{id}/transcript', {
            params: { path: { id: meetingId }, query: { transcriptId, cursor } },
          }),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data = { title: formValue(form, 'title'), description: formValue(form, 'description') };
    const path = { id: meetingId };
    setSaving(true);
    setError(undefined);
    try {
      const result = item
        ? kind === 'decision'
          ? await api.PATCH('/v1/meetings/{id}/decisions/{itemId}', {
              params: { path: { ...path, itemId: item.id } },
              body: data,
            })
          : await api.PATCH('/v1/meetings/{id}/action-items/{itemId}', {
              params: { path: { ...path, itemId: item.id } },
              body: data,
            })
        : kind === 'decision'
          ? await api.POST('/v1/meetings/{id}/decisions', {
              params: { path },
              body: { ...data, segmentIds: selected ? [selected] : [] },
            })
          : await api.POST('/v1/meetings/{id}/action-items', {
              params: { path },
              body: { ...data, segmentIds: selected ? [selected] : [] },
            });
      if (result.response.ok) onDone();
      else setError(problemMessage(result.error, 'Could not save the item.'));
    } catch {
      setError('Could not save the item.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-md border p-3 print:hidden"
      onSubmit={(event) => void submit(event)}
    >
      <FormField
        id="title"
        label="Title"
        defaultValue={item?.title ?? ''}
        maxLength={180}
        required
      />
      <div className="grid gap-1.5">
        <Label htmlFor="document-description">Description</Label>
        <Textarea
          id="document-description"
          name="description"
          defaultValue={item?.description ?? ''}
          maxLength={2000}
          required
        />
      </div>
      {!item && (
        <div className="grid gap-2">
          <Label htmlFor="segment-id">Evidence segment</Label>
          <NativeSelect
            id="segment-id"
            value={selected ?? ''}
            required
            onChange={(event) => setSelected(event.target.value || undefined)}
          >
            <option value="">Select a transcript segment</option>
            {segments.state.status === 'ok' &&
              segments.state.data.segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {formatDuration(segment.startMs)} · {segment.text.slice(0, 90)}
                </option>
              ))}
          </NativeSelect>
          {segments.state.status === 'error' && (
            <FormError message="Could not load transcript segments." />
          )}
          {segments.state.status === 'ok' && segments.state.data.nextCursor && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => {
                if (segments.state.status === 'ok')
                  setCursor(segments.state.data.nextCursor ?? undefined);
                setSelected(undefined);
              }}
            >
              Next segments
            </Button>
          )}
        </div>
      )}
      {error && <FormError message={error} />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving || (!item && !selected)}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function SummaryPanel({
  meetingId,
  revision,
  active,
  failed,
  canEdit,
  review,
  onCitation,
}: {
  meetingId: string;
  revision: string;
  active: boolean;
  failed: boolean;
  canEdit: boolean;
  review: boolean;
  onCitation: (citation: CitationTarget) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<{ kind: Kind; item?: Item }>();
  const [busy, setBusy] = useState<string>();
  const result = useApiQuery(JSON.stringify([meetingId, selected, revision]), () =>
    api.GET('/v1/meetings/{id}/document', {
      params: { path: { id: meetingId }, query: { documentId: selected } },
    }),
  );
  const [selectedDecisions, setSelectedDecisions] = useState<string[]>([]);
  const data = result.state.status === 'ok' ? result.state.data : undefined;
  const document = data?.document;
  const editable = Boolean(canEdit && !selected && document?.isCurrent);

  const proposed = document?.decisions.filter((item) => item.status === 'proposed') ?? [];
  const bulkIds = proposed
    .filter((item) => selectedDecisions.includes(item.id))
    .map((item) => item.id);

  async function bulkReview(status: 'confirmed' | 'rejected') {
    setBusy('bulk');
    try {
      const { response, error } = await api.POST('/v1/meetings/{id}/decisions/bulk-review', {
        params: { path: { id: meetingId } },
        body: { ids: bulkIds, status },
      });
      if (response.ok) {
        setSelectedDecisions([]);
        result.reload();
      } else toast.error(problemMessage(error, 'Could not review the decisions.'));
    } catch {
      toast.error('Could not review the decisions.');
    } finally {
      setBusy(undefined);
    }
  }

  async function update(kind: Kind, item: Item, change: 'confirm' | 'reject' | 'delete') {
    const path = { id: meetingId, itemId: item.id };
    setBusy(item.id);
    try {
      const response =
        change === 'delete'
          ? kind === 'decision'
            ? await api.DELETE('/v1/meetings/{id}/decisions/{itemId}', { params: { path } })
            : await api.DELETE('/v1/meetings/{id}/action-items/{itemId}', { params: { path } })
          : kind === 'decision'
            ? await api.PATCH('/v1/meetings/{id}/decisions/{itemId}', {
                params: { path },
                body: { status: change === 'confirm' ? 'confirmed' : 'rejected' },
              })
            : await api.PATCH('/v1/meetings/{id}/action-items/{itemId}', {
                params: { path },
                body: { status: change === 'confirm' ? 'done' : 'rejected' },
              });
      if (response.response.ok) result.reload();
      else toast.error(problemMessage(response.error, 'Could not update the item.'));
    } catch {
      toast.error('Could not update the item.');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card data-testid="summary-panel" data-print-document={review ? '' : undefined}>
      <CardHeader>
        <CardTitle>Summary</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        {active && (
          <p role="status" className="text-sm text-muted-foreground">
            Preparing a meeting summary.
          </p>
        )}
        {failed && (
          <p role="status" className="text-sm text-destructive">
            Summary failed. The transcript and audio are still available.
          </p>
        )}
        {result.state.status === 'loading' && <Skeleton className="h-24" />}
        {result.state.status === 'error' && (
          <FormError message={problemMessage(result.state.error, 'Could not load the summary.')} />
        )}
        {data && !document && !active && !failed && (
          <p className="text-sm text-muted-foreground">No summary yet.</p>
        )}
        {data && data.revisions.length > 1 && (
          <div className="grid max-w-md gap-1.5 print:hidden">
            <Label htmlFor="document-revision">Document version</Label>
            <NativeSelect
              id="document-revision"
              value={selected ?? ''}
              onChange={(event) => {
                setSelected(event.target.value || undefined);
                setEditing(undefined);
                setSelectedDecisions([]);
              }}
            >
              <option value="">Current summary</option>
              {data.revisions
                .filter((entry) => !entry.isCurrent)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {new Date(entry.createdAt).toLocaleString()}
                    {entry.hasHumanEdits ? ' · Has human edits' : ''}
                  </option>
                ))}
            </NativeSelect>
            {!selected &&
              data.revisions.some((entry) => !entry.isCurrent && entry.hasHumanEdits) && (
                <p className="text-sm text-muted-foreground">
                  Earlier versions contain human edits.
                </p>
              )}
          </div>
        )}
        {document && (
          <>
            {selected && review && (
              <p className="text-sm text-muted-foreground">Read-only revision</p>
            )}
            {review && (
              <div className="flex flex-wrap gap-2 print:hidden">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void copyDocumentText(
                      [
                        document.summary.paragraph,
                        ...document.summary.bullets.map((bullet) => '• ' + bullet),
                      ].join('\n'),
                    )
                  }
                >
                  Copy summary
                </Button>
                <Button size="sm" variant="outline" onClick={() => window.print()}>
                  Print document
                </Button>
              </div>
            )}
            <p className="whitespace-pre-wrap text-sm">{document.summary.paragraph}</p>
            {document.summary.bullets.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {document.summary.bullets.map((bullet, index) => (
                  <li key={index}>{bullet}</li>
                ))}
              </ul>
            )}
            {(
              [
                {
                  kind: 'decision',
                  title: 'Decisions',
                  add: 'Add decision',
                  items: document.decisions,
                },
                {
                  kind: 'action',
                  title: 'Action items',
                  add: 'Add action item',
                  items: document.actionItems,
                },
              ] as const
            ).map(({ kind, title, add, items }) => (
              <section key={kind} className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{title}</h3>
                  {editable && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="print:hidden"
                      onClick={() => setEditing({ kind })}
                    >
                      {add}
                    </Button>
                  )}
                </div>
                {review && editable && kind === 'decision' && proposed.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 print:hidden">
                    <Label>
                      <input
                        type="checkbox"
                        checked={bulkIds.length === Math.min(proposed.length, 100)}
                        onChange={(event) =>
                          setSelectedDecisions(
                            event.target.checked
                              ? proposed.slice(0, 100).map((item) => item.id)
                              : [],
                          )
                        }
                      />{' '}
                      Select proposed decisions
                    </Label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy) || bulkIds.length === 0}
                      onClick={() => void bulkReview('confirmed')}
                    >
                      Confirm selected
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy) || bulkIds.length === 0}
                      onClick={() => void bulkReview('rejected')}
                    >
                      Reject selected
                    </Button>
                  </div>
                )}
                {items.length === 0 && (
                  <p className="text-sm text-muted-foreground">No {title.toLowerCase()}.</p>
                )}
                {editing?.kind === kind && !editing.item && editable && (
                  <ItemForm
                    key={kind}
                    meetingId={meetingId}
                    transcriptId={document.transcriptId}
                    kind={kind}
                    onCancel={() => setEditing(undefined)}
                    onDone={() => {
                      setEditing(undefined);
                      result.reload();
                    }}
                  />
                )}
                {items.map((item) => (
                  <article
                    key={item.id}
                    className={
                      'grid gap-2 rounded-md border p-3' +
                      (review && item.editedByUser ? ' border-l-4 border-l-primary' : '')
                    }
                    data-testid={kind === 'decision' ? 'decision' : 'action-item'}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {review && editable && kind === 'decision' && item.status === 'proposed' && (
                        <input
                          type="checkbox"
                          className="print:hidden"
                          aria-label={'Select ' + item.title}
                          checked={selectedDecisions.includes(item.id)}
                          disabled={
                            Boolean(busy) ||
                            (!selectedDecisions.includes(item.id) && bulkIds.length >= 100)
                          }
                          onChange={(event) =>
                            setSelectedDecisions((ids) =>
                              event.target.checked
                                ? [...ids, item.id]
                                : ids.filter((id) => id !== item.id),
                            )
                          }
                        />
                      )}
                      <h4 className="text-sm font-semibold">{item.title}</h4>
                      <Badge variant="outline">{item.status}</Badge>
                      <Badge variant="secondary">
                        {item.source === 'manual'
                          ? 'Added by a person'
                          : item.editedByUser
                            ? 'Edited by a person'
                            : 'AI-generated'}
                      </Badge>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{item.description}</p>
                    {'rationale' in item && item.rationale && (
                      <p className="text-sm text-muted-foreground">{item.rationale}</p>
                    )}
                    {'ownerName' in item && (item.ownerName || item.dueDate) && (
                      <p className="text-sm text-muted-foreground">
                        {[item.ownerName, item.dueDate].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5" aria-label="Evidence">
                      {item.citations.map((citation) => (
                        <Button
                          key={citation.segmentId}
                          type="button"
                          size="xs"
                          variant="outline"
                          aria-label={`Open evidence at ${formatDuration(citation.startMs)}`}
                          onClick={() =>
                            onCitation({ ...citation, transcriptId: document.transcriptId })
                          }
                        >
                          {formatDuration(citation.startMs)}
                        </Button>
                      ))}
                    </div>
                    {review && (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="justify-self-start print:hidden"
                        onClick={() => void copyDocumentText(item.title + '\n' + item.description)}
                      >
                        Copy item
                      </Button>
                    )}
                    {editable &&
                      (editing?.item?.id === item.id ? (
                        <ItemForm
                          key={item.id}
                          meetingId={meetingId}
                          transcriptId={document.transcriptId}
                          item={item}
                          kind={kind}
                          onCancel={() => setEditing(undefined)}
                          onDone={() => {
                            setEditing(undefined);
                            result.reload();
                          }}
                        />
                      ) : (
                        <div className="flex flex-wrap gap-1 print:hidden">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setEditing({ kind, item })}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={
                              busy === item.id ||
                              item.status === 'confirmed' ||
                              item.status === 'done'
                            }
                            onClick={() => void update(kind, item, 'confirm')}
                          >
                            {kind === 'decision' ? 'Confirm' : 'Mark done'}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy === item.id || item.status === 'rejected'}
                            onClick={() => void update(kind, item, 'reject')}
                          >
                            Reject
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy === item.id}
                            onClick={() => void update(kind, item, 'delete')}
                          >
                            Delete
                          </Button>
                        </div>
                      ))}
                  </article>
                ))}
              </section>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
