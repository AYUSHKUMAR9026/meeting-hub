'use client';

import { ContentPurge } from '@/components/meetings/content-purge';
import { normalizeTimezone } from '@meeting-hub/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField, NativeSelect } from '@/components/app/form-field';
import { useCan, useWorkspace } from '@/components/app/workspace-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, problemMessage } from '@/lib/api/client';
import { formValue } from '@/lib/form';
import { AiDisclosure } from '@/components/meetings/ai-disclosure';

export default function GeneralSettingsPage() {
  const workspace = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const editable = can('workspace.update');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const timeZones = useMemo(
    () => ['UTC', ...Intl.supportedValuesOf('timeZone').map(normalizeTimezone)],
    [],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: apiError } = await api.PATCH('/v1/workspaces/{wid}', {
      params: { path: { wid: workspace.id } },
      body: {
        name: formValue(form, 'name'),
        settings: {
          contentRetention:
            formValue(form, 'contentRetention') === 'keep_transcript'
              ? 'keep_transcript'
              : 'pdf_only',
          externalAiEnabled: form.has('externalAiEnabled'),
          timezone: formValue(form, 'timezone'),
          retentionDays: Number(form.get('retentionDays')),
          ...(workspace.features.includes('sharing.enabled')
            ? { sharingEnabled: form.has('sharingEnabled') }
            : {}),
          ...(form.has('transcriptLanguage')
            ? { transcriptLanguage: formValue(form, 'transcriptLanguage').toLowerCase() || null }
            : {}),
          glossary: formValue(form, 'glossary')
            .split('\n')
            .map((term) => term.trim())
            .filter(Boolean),
        },
      },
    });
    setPending(false);
    if (apiError) {
      setError(problemMessage(apiError, 'Could not save the settings.'));
      return;
    }
    toast.success('Settings saved');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>
          {editable
            ? 'Name and defaults for everyone in this workspace.'
            : 'Only owners and admins can change these settings.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ContentPurge />
        <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-lg gap-4">
          <fieldset disabled={!editable || pending} className="grid gap-4">
            <Label>
              <input
                type="checkbox"
                name="externalAiEnabled"
                defaultChecked={workspace.settings.externalAiEnabled}
              />{' '}
              Allow external AI processing
            </Label>
            <AiDisclosure />
            <Label htmlFor="contentRetention">Content retention</Label>
            <NativeSelect
              id="contentRetention"
              name="contentRetention"
              defaultValue={workspace.settings.contentRetention ?? 'pdf_only'}
            >
              <option value="pdf_only">PDF and extracted items only</option>
              <option value="keep_transcript">Also keep transcript text</option>
            </NativeSelect>
            <p className="text-sm text-muted-foreground">
              Audio is always temporary. Changing this setting does not purge existing meetings.
              Previously deleted content cannot be recovered.
            </p>
            <FormField
              id="name"
              label="Name"
              defaultValue={workspace.name}
              required
              maxLength={80}
            />
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">Time zone</Label>
              <NativeSelect
                id="timezone"
                name="timezone"
                defaultValue={workspace.settings.timezone}
              >
                {timeZones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <FormField
              id="retentionDays"
              label="Recording retention (days)"
              type="number"
              min={1}
              max={3650}
              defaultValue={workspace.settings.retentionDays}
              required
              hint="How long raw recordings are kept before deletion."
            />
            {workspace.features.includes('transcription.enabled') && (
              <FormField
                id="transcriptLanguage"
                label="Transcription language"
                maxLength={8}
                defaultValue={workspace.settings.transcriptLanguage ?? ''}
                placeholder="Auto-detect"
                hint="Leave blank to auto-detect, or enter a language code such as en or en_us."
              />
            )}
            {workspace.features.includes('sharing.enabled') && (
              <Label>
                <input
                  type="checkbox"
                  name="sharingEnabled"
                  defaultChecked={workspace.settings.sharingEnabled}
                />{' '}
                Allow public meeting share links
              </Label>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="glossary">Glossary</Label>
              <Textarea
                id="glossary"
                name="glossary"
                rows={5}
                defaultValue={workspace.settings.glossary.join('\n')}
                placeholder={'One term per line, e.g.\nOKR\nKubernetes'}
              />
              <p className="text-xs text-muted-foreground">
                Names and jargon that help transcription get them right.
              </p>
            </div>
          </fieldset>
          <FormError message={error} />
          {editable && (
            <Button type="submit" disabled={pending} className="justify-self-start">
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
