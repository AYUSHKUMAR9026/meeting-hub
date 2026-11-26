'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/app/workspace-context';
import { Button } from '@/components/ui/button';
import { api, problemMessage } from '@/lib/api/client';
import type { components } from '@/lib/api/schema';

export function DecisionPdf({ meetingId }: { meetingId: string }) {
  const [result, setResult] = useState<components['schemas']['SavedMeetingResult']>();
  const [selected, setSelected] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const can = useCan();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await api.GET('/v1/meetings/{id}/result', {
          params: { path: { id: meetingId } },
        });
        if (active && r.data) setResult(r.data);
      } catch {
        /* The next poll repairs a transient connection failure. */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [meetingId]);
  const current = result?.files.find((f) => f.id === selected) ?? result?.files[0];
  const url = '/v1/meetings/' + meetingId + '/pdf' + (current ? '?fileId=' + current.id : '');
  return (
    <section className="grid gap-3" aria-label="Decision PDF">
      <h2 className="text-lg font-semibold">Decision PDF</h2>
      {result?.pending && (
        <p role="status">The PDF is being generated. Previous versions remain available.</p>
      )}
      {result?.state === 'failed' && (
        <div role="alert">
          <p>PDF generation failed. Your summary and extracted items remain available.</p>
          {can('processing.reprocess') && (
            <Button
              variant="outline"
              onClick={() => {
                void api
                  .POST('/v1/meetings/{id}/pdf/retry', { params: { path: { id: meetingId } } })
                  .then((r) => {
                    if (!r.response.ok) toast.error(problemMessage(r.error));
                    else toast.success('PDF generation queued');
                  });
              }}
            >
              Retry PDF
            </Button>
          )}
        </div>
      )}
      {current ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <a href={url + '&download=true'} className="underline">
              Download PDF
            </a>
            <Button
              variant="outline"
              onClick={() => {
                frame.current?.contentWindow?.focus();
                frame.current?.contentWindow?.print();
              }}
            >
              Print
            </Button>
            <label>
              Version{' '}
              <select value={current.id} onChange={(e) => setSelected(e.target.value)}>
                {result?.files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {new Date(f.generatedAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-sm text-muted-foreground">{current.meetingDateTime}</p>
          <iframe
            ref={frame}
            title="Meeting decisions PDF"
            data-testid="decision-pdf"
            src={url}
            className="h-[75vh] w-full rounded border"
          />
          <a href={url} target="_blank" rel="noreferrer" className="text-sm underline">
            Open PDF in a new tab
          </a>
        </>
      ) : (
        <p>When processing finishes, the saved decision PDF will appear here.</p>
      )}
    </section>
  );
}
