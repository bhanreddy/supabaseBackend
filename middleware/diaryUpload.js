import multer from 'multer';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 4;

const IMAGE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const AUDIO_MIME = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/aac',
]);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (!IMAGE_MIME.has(mime)) {
      return cb(new Error('Only JPEG, PNG, WebP, or HEIC images are allowed'));
    }
    cb(null, true);
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (!AUDIO_MIME.has(mime) && !mime.startsWith('audio/')) {
      return cb(new Error('Only audio recordings are allowed'));
    }
    cb(null, true);
  },
});

export const diaryPhotosUpload = imageUpload.array('photos', MAX_IMAGES);
export const diaryPhotoUpload = imageUpload.single('photo');
export const diaryAudioUpload = audioUpload.single('audio');

export function handleDiaryUploadError(error, _req, res, next) {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File is too large. Please capture again at a slightly lower resolution.' });
  }
  if (error.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: `You can attach up to ${MAX_IMAGES} photos.` });
  }
  return res.status(400).json({ error: error.message || 'Upload failed. You can still send the diary photo.' });
}

export { MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, MAX_IMAGES };
