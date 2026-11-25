'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField } from '@/components/app/form-field';
import { useCan } from '@/components/app/workspace-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage, type TranscriptSpeaker, type TranscriptPage } from '@/lib/api/client';
import { formValue } from '@/lib/form';
import { formatDuration } from '@/lib/processing';

import { ParticipantsPicker, type PickedPerson } from './participants-picker';
import type { CitationTarget } from './summary-panel';

const speakerColors = [
  'text-blue-700 dark:text-blue-300',
  'text-emerald-700 dark:text-emerald-300',
  'text-violet-700 dark:text-violet-300',
  'text-orange-700 dark:text-orange-300',
  'text-rose-700 dark:text-rose-300',
  'text-cyan-700 dark:text-cyan-300',
];

function speakerName(speaker: TranscriptSpeaker) {
  return speaker.displayName ?? speaker.personName ?? speaker.label;
}

function SpeakerEditor({
  meetingId,
  speaker,
  onSaved,
}: {
  meetingId: string;
  speaker: TranscriptSpeaker;
  onSaved: (speaker: TranscriptSpeaker) => void;
}) {
  const [person, setPerson] = useState<PickedPerson[]>(
    speaker.personId && speaker.personName
      ? [{ id: speaker.personId, displayName: speaker.personName }]
      : [],
  );
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const displayName = formValue(form, 'displayName').trim() || null;
    setSaving(true);
    try {
      const { data, error } = await api.PATCH('/v1/meetings/{id}/transcript/speakers/{speakerId}', {
        params: { path: { id: meetingId, speakerId: speaker.id } },
        body: { displayName, personId: person[0]?.id ?? null },
      });
      if (data) onSaved(data);
      else toast.error(problemMessage(error, 'Could not save the speaker.'));
    } catch {
      toast.error('Could not save the speaker.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid max-w-lg gap-3 rounded-md border p-3"
      onSubmit={(event) => void save(event)}
    >
      <FormField
        id="displayName"
        label={`Name for ${speaker.label}`}
        defaultValue={speaker.displayName ?? ''}
        maxLength={120}
      />
      <ParticipantsPicker
        value={person}
        onChange={(selected) => setPerson(selected.slice(-1))}
        disabled={saving}
      />
      <Button size="sm" type="submit" disabled={saving} className="justify-self-start">
        Save speaker
      </Button>
    </form>
  );
}

function getPage(meetingId: string, q: string, cursor?: string, citation?: CitationTarget) {
  const path = { id: meetingId };
  const selection = citation
    ? { transcriptId: citation.transcriptId, segmentId: cursor ? undefined : citation.segmentId }
    : {};
  return q
    ? api.POST('/v1/meetings/{id}/transcript/search', {
        params: { path },
        body: { q, cursor, ...selection },
      })
    : api.GET('/v1/meetings/{id}/transcript', {
        params: { path, query: { cursor, ...selection } },
      });
}

function TranscriptResults({
  page,
  meetingId,
  query,
  positionMs,
  onSeek,
  reload,
  citation,
}: {
  page: TranscriptPage;
  meetingId: string;
  query: string;
  positionMs: number;
  onSeek: (positionMs: number) => void;
  reload: () => void;
  citation?: CitationTarget | undefined;
}) {
  const can = useCan();
  const [speakers, setSpeakers] = useState(page.speakers);
  const [segments, setSegments] = useState(page.segments);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [editing, setEditing] = useState<TranscriptSpeaker | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const byId = new Map(
    speakers.map((speaker, index) => [
      speaker.id,
      { speaker, color: speakerColors[index % speakerColors.length] },
    ]),
  );

  useEffect(() => {
    if (!citation) return;
    const target = document.getElementById('transcript-' + citation.segmentId);
    target?.scrollIntoView({ block: 'nearest' });
    target?.focus({ preventScroll: true });
  }, [citation]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const { data, error, response } = await getPage(meetingId, query, cursor, citation);
      if (response.status === 409) reload();
      else if (data) {
        setSegments((previous) => [...previous, ...data.segments]);
        setCursor(data.nextCursor);
      } else toast.error(problemMessage(error, 'Could not load more segments.'));
    } catch {
      toast.error('Could not load more segments.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      {page.transcript?.fallbackReason && (
        <p role="status">
          Fallback: no speaker labels. The mixed recording was used to stay within the free quota or
          because participant audio was unavailable.
        </p>
      )}
      {!citation && can('transcript.speaker.update') && speakers.length > 0 && (
        <details className="grid gap-2">
          <summary className="cursor-pointer text-sm font-medium">Manage speakers</summary>
          <div className="my-2 flex flex-wrap gap-2">
            {speakers.map((speaker) => (
              <Button
                key={speaker.id}
                size="sm"
                variant="outline"
                aria-pressed={editing?.id === speaker.id}
                onClick={() => setEditing(editing?.id === speaker.id ? null : speaker)}
              >
                {speakerName(speaker)}
              </Button>
            ))}
          </div>
          {editing && (
            <SpeakerEditor
              key={editing.id}
              speaker={editing}
              meetingId={meetingId}
              onSaved={(updated) => {
                setSpeakers((current) =>
                  current.map((speaker) => (speaker.id === updated.id ? updated : speaker)),
                );
                setEditing(null);
              }}
            />
          )}
        </details>
      )}
      {segments.length ? (
        <ol
          className="max-h-[32rem] divide-y overflow-y-auto rounded-md border"
          aria-label="Transcript segments"
        >
          {segments.map((segment) => {
            const entry = byId.get(segment.speakerId);
            const active = positionMs >= segment.startMs && positionMs < segment.endMs;
            const timestamp = formatDuration(segment.startMs);
            return (
              <li key={segment.id}>
                <button
                  type="button"
                  onClick={() => onSeek(segment.startMs)}
                  aria-current={active ? 'true' : undefined}
                  id={'transcript-' + segment.id}
                  data-testid="transcript-segment"
                  data-start-ms={segment.startMs}
                  className={`grid w-full gap-1 px-3 py-2 text-left hover:bg-muted/80 ${active ? 'bg-muted ring-1 ring-inset ring-primary/40' : ''}`}
                >
                  <span className="flex flex-wrap items-center gap-x-3 text-xs font-medium">
                    <span className="tabular-nums text-muted-foreground">{timestamp}</span>
                    <span className={entry?.color}>
                      {entry ? speakerName(entry.speaker) : 'Speaker'}
                    </span>
                  </span>
                  <span className="whitespace-pre-wrap text-sm">{segment.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          {query ? 'No matching segments.' : 'No speech was detected.'}
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="justify-self-start"
        >
          {loadingMore ? 'Loading…' : 'Load more segments'}
        </Button>
      )}
    </>
  );
}

type TranscriptPanelProps = {
  meetingId: string;
  citation?: CitationTarget | undefined;
  revision: string;
  processing: boolean;
  failed: boolean;
  positionMs: number;
  onSeek: (positionMs: number) => void;
};

function TranscriptPageResults({
  meetingId,
  query,
  revision,
  processing,
  failed,
  positionMs,
  onSeek,
  citation,
}: TranscriptPanelProps & { query: string }) {
  const result = useApiQuery(
    JSON.stringify([meetingId, query, revision, citation?.segmentId]),
    () => getPage(meetingId, query, undefined, citation),
  );
  if (result.state.status === 'loading')
    return <Skeleton className="h-16 w-full" aria-label="Loading transcript" />;
  if (result.state.status === 'error')
    return (
      <FormError message={problemMessage(result.state.error, 'Could not load the transcript.')} />
    );
  const page = result.state.data;
  if (!page.transcript)
    return processing || failed ? null : (
      <p className="text-sm text-muted-foreground">No transcript yet.</p>
    );
  return (
    <TranscriptResults
      key={page.transcript.id + ':' + (citation?.segmentId ?? '')}
      citation={citation}
      page={page}
      meetingId={meetingId}
      query={query}
      positionMs={positionMs}
      onSeek={onSeek}
      reload={result.reload}
    />
  );
}

export function TranscriptPanel({
  meetingId,
  revision,
  processing,
  failed,
  positionMs,
  onSeek,
  citation,
}: TranscriptPanelProps) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  return (
    <Card data-testid="transcript-panel">
      <CardHeader>
        <CardTitle>Transcript</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {processing && (
          <p role="status" className="text-sm text-muted-foreground">
            Transcription is in progress.
          </p>
        )}
        {failed && (
          <p role="status" className="text-sm text-muted-foreground">
            The latest transcription failed. See processing details.
          </p>
        )}
        {!citation && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(input.trim());
            }}
          >
            <Input
              type="search"
              aria-label="Search transcript"
              maxLength={200}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search transcript"
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
            {query && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setInput('');
                  setQuery('');
                }}
              >
                Clear
              </Button>
            )}
          </form>
        )}
        <TranscriptPageResults
          key={citation?.segmentId ?? query}
          citation={citation}
          meetingId={meetingId}
          query={citation ? '' : query}
          revision={revision}
          processing={processing}
          failed={failed}
          positionMs={positionMs}
          onSeek={onSeek}
        />
      </CardContent>
    </Card>
  );
}
