// Spreadsheet helpers for the programme import dialog: XLSX -> CSV text (browser side, parser loaded on click) and
// downloadable CSV templates. The server only ever sees CSV text, so there is one import plan function.

export type TemplateKind = 'diploma' | 'standard';

type Cell = string | number | boolean | Date | null | undefined;

/** RFC 4180 quoting: wrap in quotes when the cell has a comma, quote, CR or LF; double any quotes. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  else s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: Cell[][]): string {
  // Trailing fully-empty cells/rows add nothing and only bloat the 2 MB limit.
  const trimmed = rows.map((r) => {
    let end = r.length;
    while (end > 0 && (r[end - 1] === null || r[end - 1] === undefined || r[end - 1] === '')) end--;
    return r.slice(0, end);
  });
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].length === 0) trimmed.pop();
  return trimmed.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function isXlsxFile(file: File): boolean {
  return /\.xlsx$/i.test(file.name);
}
export function isLegacyXlsFile(file: File): boolean {
  return /\.xls$/i.test(file.name);
}

/** Convert the FIRST sheet of an .xlsx file to CSV text. The parser is only downloaded when this is called. */
export async function xlsxFileToCsv(file: File): Promise<string> {
  const { readSheet } = await import('read-excel-file/browser');
  const rows = (await readSheet(file)) as Cell[][];
  return rowsToCsv(rows);
}

const HEADER = 'qualification,unit_code,unit_title,criterion_code,criterion_text,group,required,glh';

const TEMPLATES: Record<TemplateKind, { filename: string; rows: Cell[][] }> = {
  diploma: {
    filename: 'unit-import-template-diploma.csv',
    rows: [
      HEADER.split(','),
      [
        '',
        'U1',
        'Communication in care settings',
        '1.1',
        'Explain why communication matters',
        'Performance Criteria',
        1,
        30
      ],
      [
        '',
        'U1',
        'Communication in care settings',
        '1.2',
        'Describe barriers to communication',
        'Performance Criteria',
        1,
        ''
      ],
      ['', 'U2', 'Safeguarding and protection', '1.1', 'Define the term abuse', 'Knowledge', 1, 25]
    ]
  },
  standard: {
    filename: 'unit-import-template-standard.csv',
    rows: [
      HEADER.split(','),
      ['', '', 'Duty 1 Communication', 'K1', 'The scope of the role and its boundaries', 'Knowledge', 1, ''],
      ['', '', 'Duty 1 Communication', 'S1', 'Work within the limits of the role', 'Skills', 1, ''],
      ['', '', 'Duty 1 Communication', 'B1', 'Treat people with dignity and respect', 'Behaviours', 1, '']
    ]
  }
};

export function templateCsv(kind: TemplateKind): string {
  return rowsToCsv(TEMPLATES[kind].rows);
}

export function downloadTemplate(kind: TemplateKind) {
  const { filename } = TEMPLATES[kind];
  // BOM so Excel opens the UTF-8 file correctly.
  const blob = new Blob(['﻿', templateCsv(kind)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
