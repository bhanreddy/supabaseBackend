import multer from 'multer';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const name = String(file.originalname || '').toLowerCase();
  const okExt = name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv');
  if (!okExt) {
    return cb(new Error('Only .xlsx, .xls, or .csv files are allowed'));
  }
  cb(null, true);
};

export const excelUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter,
});

export const singleExcelUpload = excelUpload.single('file');

export const handleMulterError = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' });
  }
  return res.status(400).json({ error: err.message || 'File upload failed' });
};
