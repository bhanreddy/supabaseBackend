import express from 'express';
import { sendSuccess } from '../utils/apiResponse.js';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/', requireAuth, (req, res) => {
  const { msg, data } = req.body;
  const timestamp = new Date().toISOString();
  const schoolId = req.schoolId || 'unknown';
  const logEntry = `${timestamp} - [CLIENT] school=${schoolId} ${msg} ${data ? JSON.stringify(data) : ''}\n`;

  try {
    fs.appendFileSync('debug_log.txt', logEntry);
  } catch (err) {
    // non-fatal
  }

  return sendSuccess(res, req.schoolId, { message: 'Logged' });
});

export default router;