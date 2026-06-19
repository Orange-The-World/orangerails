/**
 * Wave customers.json + vendors.json → V3 Contacts CSV.
 *
 * V3 Contacts columns (from src/lib/csv/contacts.ts):
 *   Name, Type, Email, Phone, Street, City, State, Country, Zip
 *
 * Wave Type → V3 Type:
 *   customers.json → 'Customer'
 *   vendors.json   → 'Vendor'
 *   (V3 also accepts 'Employee' and 'Other'; Wave has no equivalents.)
 *
 * Phone field selection: prefer node.phone, fall back to mobile.
 *
 * Address mapping:
 *   addressLine1 → Street (addressLine2 appended with a comma if present)
 *   city → City
 *   province → State
 *   country → Country
 *   postalCode → Zip
 *
 * Name fallback chain: node.name → "firstName lastName" → '(unnamed)'.
 * Empty/null fields become empty cells, never the literal string "null".
 */

import { buildCsv } from './csv-utils';
import type { WavePartyNode } from './types';
import { unwrapNodes } from './types';

export const V3_CONTACT_HEADERS = [
  'Name',
  'Type',
  'Email',
  'Phone',
  'Street',
  'City',
  'State',
  'Country',
  'Zip',
] as const;

export type ContactsResult = {
  csv: string;
  rowCount: number;
  warnings: string[];
};

function pickName(p: WavePartyNode): string {
  const n = (p.name ?? '').trim();
  if (n) return n;
  const combined = `${(p.firstName ?? '').trim()} ${(p.lastName ?? '').trim()}`.trim();
  return combined || '(unnamed)';
}

function pickStreet(p: WavePartyNode): string {
  const a = p.address;
  if (!a) return '';
  const l1 = (a.addressLine1 ?? '').trim();
  const l2 = (a.addressLine2 ?? '').trim();
  return [l1, l2].filter(Boolean).join(', ');
}

/** Wave province codes look like "CA-ON" or "US-CA"; strip the country prefix. */
function pickProvince(a: WavePartyNode['address']): string {
  if (!a?.province) return '';
  const code = a.province.code ?? '';
  const m = code.match(/^[A-Z]{2}-(.+)$/);
  return (m ? m[1] : code).trim();
}

function pickCountry(a: WavePartyNode['address']): string {
  if (!a?.country) return '';
  return (a.country.code ?? '').trim();
}

function partyRow(p: WavePartyNode, type: 'Customer' | 'Vendor'): unknown[] {
  const a = p.address;
  return [
    pickName(p),
    type,
    (p.email ?? '').trim(),
    ((p.phone ?? p.mobile) ?? '').trim(),
    pickStreet(p),
    (a?.city ?? '').trim(),
    pickProvince(a),
    pickCountry(a),
    (a?.postalCode ?? '').trim(),
  ];
}

export function buildContactsCsv(
  customers: WavePartyNode[],
  vendors: WavePartyNode[],
): ContactsResult {
  const warnings: string[] = [];
  const rows: unknown[][] = [];

  for (const c of customers) {
    if (!pickName(c) || pickName(c) === '(unnamed)') {
      warnings.push(`Customer ${c.id} has no name; emitted as "(unnamed)".`);
    }
    rows.push(partyRow(c, 'Customer'));
  }
  for (const v of vendors) {
    if (!pickName(v) || pickName(v) === '(unnamed)') {
      warnings.push(`Vendor ${v.id} has no name; emitted as "(unnamed)".`);
    }
    rows.push(partyRow(v, 'Vendor'));
  }

  return {
    csv: buildCsv([...V3_CONTACT_HEADERS], rows),
    rowCount: rows.length,
    warnings,
  };
}

export function parseWavePartiesJson(raw: string): WavePartyNode[] {
  return unwrapNodes<WavePartyNode>(JSON.parse(raw));
}
