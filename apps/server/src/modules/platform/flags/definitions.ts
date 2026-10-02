/**
 * Registry of every feature flag the code knows about. Gating a feature means:
 *   1. add its key here with a safe default, and
 *   2. check `featureFlags.isEnabled('<key>')` at the feature's entry point.
 * The database (per workspace or global) and FEATURE_FLAGS_OVERRIDE can then flip it.
 */
export const flagDefinitions = {
  'platform.heartbeat': {
    description: 'Run the maintenance heartbeat job in the worker.',
    defaultEnabled: true,
  },
} as const satisfies Record<string, { description: string; defaultEnabled: boolean }>;

export type FlagKey = keyof typeof flagDefinitions;

export const isKnownFlag = (key: string): key is FlagKey => Object.hasOwn(flagDefinitions, key);
