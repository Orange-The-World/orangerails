/**
 * Tiny CSV utilities for client-side export.
 *
 * Kept as a separate module so it can be unit-tested in isolation and reused
 * by any future export surface (per-connection, per-wallet, etc.). All CSV
 * generation in OrangeRails MUST go through this , never hand-roll the
 * escaping. RFC 4180 quoting: wrap in double quotes when the cell contains
 * comma, quote, CR, or LF; escape internal double quotes by doubling them.
 */

/** Escape a single field per RFC 4180. */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build a full CSV string from a header row + data rows.
 *
 * Lines are joined with CRLF (RFC 4180); Excel and Google Sheets both
 * recognize this without sniffing.
 */
export function buildCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsvField).join(","));
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Trigger a browser download for the given CSV text.
 *
 * Builds a Blob (UTF-8, with no BOM , Excel handles plain UTF-8 fine on
 * modern versions), creates an object URL, clicks a temporary anchor, then
 * revokes the URL to release memory.
 */
export function downloadCsv(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Some browsers require the anchor to be in the DOM to honor `download`.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the blob URL on the next tick so the click has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Today's date as YYYY-MM-DD, used in export filenames. */
export function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
