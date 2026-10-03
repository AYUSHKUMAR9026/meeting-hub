/**
 * Registry of every feature flag the code knows about. Gating a feature means:
 *   1. add its key here with a safe default, and
 *   2. check `featureFlags.isEnabled('<key>')` at the feature's entry point.
 * The database (per workspace or global) and FEATURE_FLAGS_OVERRIDE can then flip it.
 * `developmentDefault` (optional) replaces the default when NODE_ENV=development.
 */
export interface FlagDefinition {
  description: string;
  defaultEnabled: boolean;
  developmentDefault?: boolean;
}

export const flagDefinitions = {
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
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof flagDefinitions;

export const isKnownFlag = (key: string): key is FlagKey => Object.hasOwn(flagDefinitions, key);
