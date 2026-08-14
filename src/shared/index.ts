/**
 * src/shared — shared helpers, named bounds, contracts.
 * Re-exports the pi-subagents configuration module.
 */
export * from './config.js';

export interface SharedPlaceholder {
  readonly module: 'shared';
}

export const sharedStub: SharedPlaceholder = { module: 'shared' };
