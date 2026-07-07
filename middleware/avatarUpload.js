import multer from 'multer';

// Upload ceiling BEFORE compression. Real camera/gallery photos are multi-MB;
// the server re-encodes down to the 50–100 KB band (see utils/avatarImage.js),
// so this limit only rejects absurdly large inputs, not normal photos.
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const storage = multer.memoryStorage();

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const fileFilter = (_req, file, cb) => {
  const mime = String(file.mimetype || '').toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return cb(new Error('Only JPEG, PNG, WebP, or HEIC images are allowed'));
  }
  cb(null, true);
};

export const avatarUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter,
});

// Field name is "photo" — the app appends the picked image under this key.
export const singleAvatarUpload = avatarUpload.single('photo');

export const handleAvatarMulterError = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Image too large. Maximum size is 15 MB.' });
  }
  return res.status(400).json({ error: err.message || 'Image upload failed' });
};
