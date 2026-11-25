import PDFDocument from 'pdfkit';
import { Types } from 'mongoose';
import { ClassSection, FeeDue, Payment, School, Student, classLabel } from '../models';
import { notFound } from '../utils/errors';
import { saveFile } from './storage';

interface ReceiptData {
  schoolName: string;
  schoolAddress?: string;
  receiptNo: string;
  date: string;
  studentName: string;
  admissionNo: string;
  className: string;
  items: { label: string; amount: number }[];
  total: number;
  mode: string;
  transactionId: string;
}

const rupees = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function renderPdf(d: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text(d.schoolName, { align: 'center' });
    if (d.schoolAddress) doc.fontSize(9).font('Helvetica').text(d.schoolAddress, { align: 'center' });
    doc.moveDown(0.6).fontSize(12).font('Helvetica-Bold').text('FEE RECEIPT', { align: 'center' });
    doc.moveDown();

    doc.fontSize(10).font('Helvetica');
    const row = (k: string, v: string) => doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(v).font('Helvetica');
    row('Receipt No', d.receiptNo);
    row('Date', d.date);
    row('Student', `${d.studentName} (Adm. ${d.admissionNo})`);
    row('Class', d.className);
    doc.moveDown();

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    doc.font('Helvetica-Bold').text('Particulars', left, doc.y, { continued: false });
    doc.moveUp().text('Amount', left, doc.y, { align: 'right' });
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).stroke();
    doc.moveDown(0.5).font('Helvetica');
    for (const item of d.items) {
      doc.text(item.label, left, doc.y);
      doc.moveUp().text(rupees(item.amount), left, doc.y, { align: 'right' });
    }
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).stroke();
    doc.moveDown(0.5).font('Helvetica-Bold').text('Total paid', left, doc.y);
    doc.moveUp().text(rupees(d.total), left, doc.y, { align: 'right' });
    doc.moveDown().font('Helvetica');
    row('Payment mode', d.mode);
    row('Transaction ID', d.transactionId);

    doc.moveDown(2).fontSize(8).fillColor('#666').text('This is a computer-generated receipt and does not need a signature.', { align: 'center' });
    doc.end();
  });
}

/** Builds the PDF receipt for a paid payment and stores it. Returns the storage key. */
export async function generateReceipt(paymentId: Types.ObjectId): Promise<string> {
  const payment = await Payment.findById(paymentId);
  if (!payment || payment.status !== 'paid' || !payment.receiptNo) throw notFound('Paid payment not found');
  if (payment.receiptKey) return payment.receiptKey;

  const [school, student, dues] = await Promise.all([
    School.findById(payment.schoolId).lean(),
    Student.findById(payment.studentId).lean(),
    FeeDue.find({ _id: { $in: payment.dueIds } }).sort({ installmentNo: 1 }).lean(),
  ]);
  const cls = student ? await ClassSection.findById(student.classId).lean() : null;

  const pdf = await renderPdf({
    schoolName: school?.name ?? 'School',
    schoolAddress: school?.address,
    receiptNo: payment.receiptNo,
    date: (payment.paidAt ?? new Date()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    studentName: student?.name ?? '',
    admissionNo: student?.admissionNo ?? '',
    className: classLabel(cls),
    items: dues.map((d) => ({ label: `${d.label} (${d.academicYear})`, amount: d.amount })),
    total: payment.amount,
    mode: payment.method ? `Online (${payment.method.toUpperCase()})` : 'Online',
    transactionId: payment.gatewayPaymentId ?? payment.gatewayOrderId,
  });

  const file = await saveFile(pdf, {
    folder: `receipts/${payment.schoolId.toString()}`,
    originalName: `${payment.receiptNo.replace(/\//g, '-')}.pdf`,
    mime: 'application/pdf',
  });
  payment.receiptKey = file.key;
  await payment.save();
  return file.key;
}
