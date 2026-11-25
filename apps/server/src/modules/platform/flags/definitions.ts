/**
 * Registry of every feature flag the code knows about. Gating a feature means:
 *   1. add its key here with a safe default, and
 *   2. check `featureFlags.isEnabled('<key>')` at the feature's entry point.
 * The database (per workspace or global) and FEATURE_FLAGS_OVERRIDE can then flip it.
 * `developmentDefault` (optional) replaces the default when NODE_ENV=development.
 * `clientVisible` flags are listed in the workspace response (`features`) so the UI can hide
 * features that are off; the API still enforces them.
 */
export interface FlagDefinition {
  description: string;
  defaultEnabled: boolean;
  developmentDefault?: boolean;
  clientVisible?: boolean;
}

/** Flags whose on/off state the web app may see (to hide UI for disabled features). */
export const clientVisibleFlags = (): FlagKey[] =>
  (Object.entries(flagDefinitions) as [FlagKey, FlagDefinition][])
    .filter(([, def]) => def.clientVisible)
    .map(([key]) => key);

export const flagDefinitions = {
  'transcription.per_track_speakers': {
    description: 'Use participant audio tracks and attendance for speaker labels.',
    defaultEnabled: false,
  },
  'rooms.enabled': {
    description: 'Host and join live workspace meeting rooms.',
    defaultEnabled: false,
    clientVisible: true,
  },
  'platform.heartbeat': {
    description: 'Run the maintenance heartbeat job in the worker.',
    defaultEnabled: true,
  },
  'auth.google_signin': {
    description: 'Offer "Sign in with Google" (also needs GOOGLE_CLIENT_ID/SECRET).',
    defaultEnabled: false,
  },
  'workspaces.invitations': {
    description: 'Invite people to a workspace by email, and accept invitations.',
    defaultEnabled: false,
    developmentDefault: true,
  },
  'people.directory': {
    description: 'The per-workspace people directory API and settings page.',
    defaultEnabled: false,
    developmentDefault: true,
  },
  'meetings.upload': {
    description: 'Upload meeting recordings straight from the browser to object storage.',
    defaultEnabled: false,
    developmentDefault: true,
    clientVisible: true,
  },
  'exports.enabled': {
    description: 'Download meeting documents and transcripts.',
    defaultEnabled: false,
    clientVisible: true,
  },
  'sharing.enabled': {
    description: 'Create and use public meeting share links.',
    defaultEnabled: false,
    clientVisible: true,
  },
  'review.enabled': {
    description: 'Track meeting decisions and actions and enable review controls.',
    defaultEnabled: false,
    clientVisible: true,
  },
  'analysis.enabled': {
    description: 'Generate a cited meeting summary, decisions and action items.',
    defaultEnabled: false,
    clientVisible: true,
  },
  'transcription.enabled': {
    description: 'Transcribe normalized recordings with speaker labels.',
    defaultEnabled: false,
    clientVisible: true,
  },
  'pipeline.media': {
    description:
      'Start a processing run when a recording finishes uploading (prepare_media), and allow reprocessing.',
    defaultEnabled: false,
    developmentDefault: true,
    clientVisible: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof flagDefinitions;

export const isKnownFlag = (key: string): key is FlagKey => Object.hasOwn(flagDefinitions, key);
