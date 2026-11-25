'use client';
import { useWorkspace } from '@/components/app/workspace-context';

export function AiDisclosure() {
  const workspace = useWorkspace();
  return (
    <p className="text-sm text-muted-foreground">
      {workspace.aiProviders.length
        ? `When external AI processing is enabled, audio is sent for transcription and transcript text is sent for analysis to the configured third-party providers: ${workspace.aiProviders.join(', ')}. ${workspace.settings.externalAiEnabled ? 'External AI processing is enabled.' : 'External AI processing is off; an owner or admin must enable it in Settings.'}`
        : 'Local test providers are configured. Audio and transcript text are not sent to third-party AI providers.'}
    </p>
  );
}
