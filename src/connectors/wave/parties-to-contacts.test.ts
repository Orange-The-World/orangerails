import { describe, it, expect } from 'vitest';
import { buildContactsCsv, parseWavePartiesJson, V3_CONTACT_HEADERS } from './parties-to-contacts';

const CUSTOMERS = JSON.stringify([
  {
    node: {
      id: 'cust-1',
      name: 'Acme Corp',
      firstName: null,
      lastName: null,
      email: 'billing@acme.com',
      phone: '555-0100',
      mobile: null,
      isArchived: false,
      currency: { code: 'CAD' },
      address: {
        addressLine1: '123 Main St',
        addressLine2: 'Suite 4',
        city: 'Toronto',
        province: { code: 'CA-ON' },
        country: { code: 'CA' },
        postalCode: 'M5V 1A1',
      },
    },
  },
  {
    node: {
      id: 'cust-2',
      name: null,
      firstName: 'Jane',
      lastName: 'Doe',
      email: null,
      phone: null,
      mobile: '555-9999',
      isArchived: false,
      currency: null,
      address: null,
    },
  },
]);

const VENDORS = JSON.stringify([
  {
    node: {
      id: 'vend-1',
      name: 'Heat Co',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      mobile: '',
      isArchived: false,
      currency: { code: 'CAD' },
      address: { addressLine1: '', addressLine2: '', city: '', postalCode: '', province: null, country: null },
    },
  },
]);

describe('parties-to-contacts', () => {
  it('emits V3 Contacts header row first', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), parseWavePartiesJson(VENDORS));
    const lines = out.csv.trim().split('\n');
    expect(lines[0]).toBe(V3_CONTACT_HEADERS.join(','));
  });

  it('tags customers as Customer and vendors as Vendor', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), parseWavePartiesJson(VENDORS));
    expect(out.csv).toMatch(/Acme Corp.*Customer/);
    expect(out.csv).toMatch(/Heat Co.*Vendor/);
  });

  it('builds name from firstName + lastName when name field is null', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), []);
    expect(out.csv).toContain('Jane Doe');
  });

  it('falls back to mobile when phone is missing', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), []);
    expect(out.csv).toContain('555-9999');
  });

  it('joins addressLine1 + addressLine2 into Street with comma', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), []);
    // Embedded comma in the joined field gets the cell quoted by csv-utils.
    expect(out.csv).toContain('"123 Main St, Suite 4"');
  });

  it('never emits the literal "null" for missing fields', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), parseWavePartiesJson(VENDORS));
    expect(out.csv).not.toContain('null');
  });

  it('strips the country prefix from province codes like CA-ON', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), []);
    // Acme Corp in Toronto should land in column "State" as "ON", not "CA-ON".
    expect(out.csv).toMatch(/Acme Corp.*,Toronto,ON,CA,M5V 1A1/);
  });

  it('counts both lists in rowCount', () => {
    const out = buildContactsCsv(parseWavePartiesJson(CUSTOMERS), parseWavePartiesJson(VENDORS));
    expect(out.rowCount).toBe(3);
  });
});
