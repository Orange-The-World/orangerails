import { describe, it, expect } from 'vitest';
import { buildCsv, csvCell, parseCsv } from './csv-utils';

describe('csv-utils', () => {
  it('quotes cells with commas, quotes, or newlines', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('emits empty cells for null / undefined / empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('')).toBe('');
  });

  it('builds full CSV with header row and trailing newline', () => {
    const out = buildCsv(['A', 'B'], [
      ['1', '2'],
      ['x', 'y,z'],
    ]);
    expect(out).toBe('A,B\n1,2\nx,"y,z"\n');
  });

  it('parses CSV with quoted multi-line and embedded-quote cells', () => {
    const text = 'Name,Note\n"Acme","line1\nline2"\n"He said ""hi""","done"\n';
    const rows = parseCsv(text);
    expect(rows).toEqual([
      ['Name', 'Note'],
      ['Acme', 'line1\nline2'],
      ['He said "hi"', 'done'],
    ]);
  });

  it('round-trips through buildCsv → parseCsv', () => {
    const headers = ['x', 'y'];
    const rows = [['hello, world', 'q"q'], ['', 'ok']];
    const csv = buildCsv(headers, rows);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(headers);
    expect(parsed.slice(1)).toEqual(rows);
  });
});
