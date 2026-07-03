export function toCsv(rows: Array<Array<string | number | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell === undefined ? '' : String(cell);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
}

export function downloadFile(filename: string, content: string, mime = 'text/plain'): void {
  // BOM so Excel opens UTF-8 CSV correctly.
  const blob = new Blob(['﻿' + content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
