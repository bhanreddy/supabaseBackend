
import admin from 'firebase-admin';
import 'dotenv/config';

// Initialize only once
if (!admin.apps.length) {
    try {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FIREBASE_PRIVATE_KEY;

        if (projectId && clientEmail && privateKey) {
            // Clean up the private key
            let formattedKey = privateKey.trim();
            if (formattedKey.startsWith('"') && formattedKey.endsWith('"')) {
                formattedKey = formattedKey.substring(1, formattedKey.length - 1);
            }
            formattedKey = formattedKey.replace(/\\n/g, '\n');

            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey: formattedKey
                })
            });
            console.log('Firebase initialized with individual environment variables');
        } else {
            console.warn('Firebase individual variables missing in .env. Push notifications will not work.');
        }
    } catch (error) {
        console.error('Failed to initialize Firebase:', error.message);
    }
}

export default admin;
