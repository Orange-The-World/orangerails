import ExcelJS from 'exceljs';

export type CellValue = string | number | boolean | Date | null;

// In V3 we call this from the browser. exceljs accepts both ArrayBuffer and
// Buffer; on the browser side we only need ArrayBuffer (what File.arrayBuffer()
// returns). In Node (vitest) Buffer also works because Buffer extends
// Uint8Array, which exceljs handles.
export type WorkbookSource = ArrayBuffer | Uint8Array;

export async function loadWorkbook(source: WorkbookSource): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(source as ArrayBuffer);
  return workbook;
}

export function firstWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('Workbook has no worksheets.');
  }
  return worksheet;
}

export function cellToString(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const richText = (value as { richText?: Array<{ text?: string }> }).richText;
    if (Array.isArray(richText)) {
      return richText.map((part) => part.text ?? '').join('').trim();
    }
    const text = (value as { text?: string }).text;
    if (typeof text === 'string') return text.trim();
    const result = (value as { result?: unknown }).result;
    if (result != null) return cellToString(result);
    // QuickBooks exports store numeric cells as Excel formulas ("=5.00", "=-1984.11").
    // Most of the time exceljs gives us the cached result alongside. When a file has
    // been round-tripped through another tool that drops the cache, the `result`
    // field is missing and we'd fall through to `[object Object]`. Evaluate literal
    // numeric formulas here so parseMoney() downstream sees a number.
    const formula = (value as { formula?: unknown }).formula;
    if (typeof formula === 'string') {
      const match = formula.trim().match(/^=?\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (match) return match[1];
    }
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^=\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (match) return match[1];
  }
  return String(value).trim();
}

export function rowValues(worksheet: ExcelJS.Worksheet, rowNumber: number): string[] {
  const row = worksheet.getRow(rowNumber);
  const values: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    values[colNumber - 1] = cellToString(cell.value);
  });
  return values;
}

export function worksheetRows(worksheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = cellToString(cell.value);
    });
    rows[rowNumber - 1] = values;
  });
  return rows.filter((row) => row.some((value) => value.trim().length > 0));
}

export function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function findHeaderRow(rows: string[][], required: string[]): number {
  const normalizedRequired = required.map(normalizeHeader);
  return rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return normalizedRequired.every((header) => headers.includes(header));
  });
}

export function columnIndex(headers: string[], names: string[]): number {
  const normalized = headers.map(normalizeHeader);
  const candidates = names.map(normalizeHeader);
  return normalized.findIndex((header) => candidates.includes(header));
}

export function parseMoney(value: string): string {
  const trimmed = value.replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1').trim();
  if (!trimmed) return '0';
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? String(parsed) : '0';
}
