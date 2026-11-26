'use client';
import { useWorkspace } from '@/components/app/workspace-context';

export function AiDisclosure() {
  const workspace = useWorkspace();
  return (
    <p className="text-sm text-muted-foreground">
      {workspace.aiProviders.length
        ? `When external AI processing is enabled, audio is sent for transcription and transcript text is sent for analysis to the configured third-party providers: ${workspace.aiProviders.join(', ')}. ${workspace.settings.externalAiEnabled ? 'External AI processing is enabled.' : 'External AI processing is off; an owner or admin must enable it in Settings.'}`
        : 'Local test providers are configured. Audio and transcript text are not sent to third-party AI providers.'}{' '}
      Audio is temporary processing input and is deleted after transcription, or on permanent
      failure, with a maximum lifetime of 48 hours. The saved result is a PDF and extracted summary,
      decisions and action items.{' '}
      {workspace.settings.contentRetention === 'keep_transcript'
        ? 'This workspace also keeps transcript text.'
        : 'Transcript text is deleted after the PDF is verified.'}{' '}
      Third-party providers control their own retention; Meeting Hub cannot control it.
    </p>
  );
}
