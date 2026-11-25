import multer from 'multer';
import { badRequest } from '../utils/errors';

const MB = 1024 * 1024;

/** Homework and leave attachments: images or PDF, up to 10 MB each, at most 5 files. */
export const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * MB, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(badRequest('Only images or PDF files are allowed'));
  },
});

/** Excel uploads (student lists). */
export const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * MB, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    if (ok) cb(null, true);
    else cb(badRequest('Please upload the .xlsx template'));
  },
});
