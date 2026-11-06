// Small RFC-4180 style CSV parser (no dependencies). Handles quoted fields, escaped quotes (""), commas and
// newlines inside quotes, CRLF / LF / CR line endings and a leading BOM. Blank lines are skipped.

/** Parse CSV text into rows of string cells (cells are NOT trimmed — callers decide). */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cellStarted = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    // A line with a single empty cell is a blank line.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !cellStarted) {
      inQuotes = true;
      cellStarted = true;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
      cellStarted = true;
    }
  }
  // Last line without a trailing newline.
  if (cell !== '' || cellStarted || row.length > 0) endRow();
  return rows;
}

/**
 * Parse CSV with a header row into objects keyed by the lower-cased, trimmed header. Row numbers are 1-based
 * file lines of the first physical row of each record (header = 1) — used for error messages.
 */
export function parseCsvWithHeader(input: string): {
  headers: string[];
  records: { row: number; values: Record<string, string> }[];
} {
  const rows = parseCsv(input);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((cells, i) => {
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) values[h] = (cells[idx] ?? '').trim();
    });
    return { row: i + 2, values };
  });
  return { headers, records };
}
