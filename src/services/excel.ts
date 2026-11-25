import ExcelJS from 'exceljs';

export const STUDENT_COLUMNS = [
  { key: 'admission_no', header: 'admission_no', width: 16, required: true },
  { key: 'student_name', header: 'student_name', width: 24, required: true },
  { key: 'class', header: 'class', width: 8, required: true },
  { key: 'section', header: 'section', width: 8, required: true },
  { key: 'roll_no', header: 'roll_no', width: 8, required: false },
  { key: 'gender', header: 'gender', width: 8, required: false },
  { key: 'dob', header: 'dob (YYYY-MM-DD)', width: 16, required: false },
  { key: 'parent1_name', header: 'parent1_name', width: 22, required: true },
  { key: 'parent1_phone', header: 'parent1_phone', width: 16, required: true },
  { key: 'parent1_relation', header: 'parent1_relation', width: 14, required: false },
  { key: 'parent2_name', header: 'parent2_name', width: 22, required: false },
  { key: 'parent2_phone', header: 'parent2_phone', width: 16, required: false },
  { key: 'parent2_relation', header: 'parent2_relation', width: 14, required: false },
] as const;

export type StudentColumnKey = (typeof STUDENT_COLUMNS)[number]['key'];
export type StudentRow = { row: number; values: Record<StudentColumnKey, string> };

const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

export async function studentTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');
  ws.columns = STUDENT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.addRow({
    admission_no: 'A1001',
    student_name: 'Aarav Sharma',
    class: '6',
    section: 'B',
    roll_no: 1,
    gender: 'M',
    dob: '2014-05-12',
    parent1_name: 'Rohit Sharma',
    parent1_phone: '9876543210',
    parent1_relation: 'Father',
    parent2_name: 'Neha Sharma',
    parent2_phone: '9876543211',
    parent2_relation: 'Mother',
  });
  const notes = wb.addWorksheet('How to fill');
  notes.addRows([
    ['Required columns: admission_no, student_name, class, section, parent1_name, parent1_phone'],
    ['Class and section must already exist in the admin website (Classes page).'],
    ['Phone numbers: 10-digit Indian mobile numbers. Brothers and sisters with the same parent number are linked automatically.'],
    ['Delete the example row before uploading.'],
  ]);
  return toBuffer(wb);
}

/** Reads the first sheet; maps columns by header name (case-insensitive). */
export async function readStudentRows(buffer: Buffer): Promise<StudentRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headerIndex = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const name = cell.text.trim().toLowerCase().split(' ')[0];
    headerIndex.set(name, col);
  });

  const rows: StudentRow[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {} as Record<StudentColumnKey, string>;
    let empty = true;
    for (const c of STUDENT_COLUMNS) {
      const col = headerIndex.get(c.key);
      const text = col ? row.getCell(col).text.trim() : '';
      if (text) empty = false;
      values[c.key] = text;
    }
    if (!empty) rows.push({ row: rowNumber, values });
  });
  return rows;
}

export async function buildXlsx(
  sheetName: string,
  columns: { header: string; key: string; width?: number }[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
  return toBuffer(wb);
}
