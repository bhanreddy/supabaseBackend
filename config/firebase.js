
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = path.resolve(__dirname, '../../service-account.json');

// Initialize only once
if (!admin.apps.length) {
    try {
        if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase initialized with service-account.json');
        } else if (process.env.FIREBASE_CONFIG) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase initialized with environment variables');
        } else {
            console.warn('Firebase configuration missing. Push notifications may not work.');
        }
    } catch (error) {
        console.error('Failed to initialize Firebase:', error.message);
    }
}

export default admin;
