/**
 * Orange Rails - Lightning Network confirms client public surface.
 *
 * Supports Alby and Zeus today. Breez follows in a subsequent PR.
 *
 * Usage:
 *   import { AlbyConfirmsClient, ZeusConfirmsClient } from '@/connectors/lightning';
 *   const client = new AlbyConfirmsClient({ accessToken: '...' });
 *   const settled = await client.fetchSettled({ after: '2026-01-01T00:00:00Z' });
 */

export type {
  LNSettledState,
  LNInvoice,
  LNProviderName,
  LNFetchOptions,
} from './types';

export { toIsoSettledAt, toLNSettledState } from './client';
export type { LNConfirmsClient } from './client';

export { AlbyConfirmsClient } from './alby';
export type { AlbyConfirmsClientOptions } from './alby';

export { ZeusConfirmsClient } from './zeus';
export type { ZeusConfirmsClientOptions } from './zeus';
