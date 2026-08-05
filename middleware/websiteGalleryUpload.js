import multer from 'multer';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      return cb(new Error('Only JPEG, PNG, WebP, or HEIC images are allowed'));
    }
    cb(null, true);
  },
});

export const singleWebsiteGalleryImage = upload.single('image');

export function handleWebsiteGalleryUploadError(error, _req, res, next) {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Image too large. Maximum size is 15 MB.' });
  }
  return res.status(400).json({ error: error.message || 'Image upload failed' });
}
