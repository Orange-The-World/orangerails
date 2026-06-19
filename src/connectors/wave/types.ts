/**
 * Wave Accounting → BitBooks connector , shape definitions.
 *
 * Wave returns GraphQL edges wrapped as `{ node: { ... } }`. The backup script
 * dumps the unwrapped node-array as JSON. Both shapes are accepted by the
 * normalizers below.
 */

export type WaveAccountNode = {
  id: string;
  name: string;
  displayId: string | null;
  description: string | null;
  isArchived: boolean;
  type: {
    name: string;
    normalBalanceType: 'DEBIT' | 'CREDIT';
    value: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  };
  subtype: { name: string; value: string } | null;
  currency: { code: string } | null;
  balance?: string;
  balanceInBusinessCurrency?: string;
};

export type WavePartyNode = {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  mobile?: string | null;
  phone?: string | null;
  internalNotes?: string | null;
  currency?: { code: string } | null;
  isArchived: boolean;
  address?: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    /** Wave returns province as { code, name? } when set, null otherwise. */
    province: { code: string; name?: string } | null;
    /** Wave returns country as { code, name? } when set, null otherwise. */
    country: { code: string; name?: string } | null;
  } | null;
};

export type WaveEdge<T> = { node: T };

/** Normalize whatever the dump gives us into a plain array of nodes. */
export function unwrapNodes<T>(raw: unknown): T[] {
  if (!Array.isArray(raw)) {
    throw new Error('Expected a JSON array of Wave edges or nodes.');
  }
  return raw.map((entry) => {
    if (entry && typeof entry === 'object' && 'node' in (entry as object)) {
      return (entry as WaveEdge<T>).node;
    }
    return entry as T;
  });
}

/** Stable, deterministic code derived from a Wave account ID. */
export type CodeMap = Map<string, string>;
