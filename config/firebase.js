
import admin from 'firebase-admin';
import config from './env.js';
import logger from '../utils/logger.js';

// Initialize only once
// Initialize only once
if (!admin.apps.length) {
  try {
    if (!config.firebase.enabled) {
      logger.info('Firebase Admin SDK disabled (missing env).');
      // Exporting `admin` is still safe; callers should handle disabled state.
      throw new Error('FIREBASE_DISABLED');
    }

    const { projectId, clientEmail, privateKey } = config.firebase;

    // Clean up the private key
    let formattedKey = privateKey.trim();
    if (formattedKey.startsWith('"') && formattedKey.endsWith('"')) {
      formattedKey = formattedKey.substring(1, formattedKey.length - 1);
    }
    formattedKey = formattedKey.replace(/\\n/g, '\n');

    // Add PEM headers if missing
    if (!formattedKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
      formattedKey = `-----BEGIN PRIVATE KEY-----\n${formattedKey}\n-----END PRIVATE KEY-----`;
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: formattedKey
      })
    });

    logger.info({ projectId }, 'Firebase Admin SDK initialized');
  } catch (error) {
    if (error.message === 'FIREBASE_DISABLED') {
      // already logged above
    } else {
      logger.error({ error: error?.message }, 'Firebase Admin SDK initialization FAILED');
    }
  }
}

export default admin;