
import express from 'express';
import { sendAttendanceNotification } from '../services/notificationService.js';
import sql from '../db.js';

const router = express.Router();

router.post('/attendance', async (req, res, next) => {
    try {
        const { student_id, student_name, status, date } = req.body;

        if (!student_id || !status) {
            return res.status(400).json({ error: 'Missing student_id or status' });
        }

        console.log(`Processing attendance notification for Student: ${student_id} (${student_name}), Status: ${status}`);

        // 1. Find Parents linked to the student
        const parents = await sql`
      SELECT 
        u.id as user_id, 
        u.preferred_language,
        p.first_name,
        p.last_name
      FROM student_parents sp
      JOIN parents par ON sp.parent_id = par.id
      JOIN users u ON par.person_id = u.person_id
      JOIN persons p ON par.person_id = p.id
      WHERE sp.student_id = ${student_id}
      AND u.account_status = 'active'
    `;

        if (!parents || parents.length === 0) {
            console.log('No registered parent users found for this student.');
            return res.status(200).json({ message: 'No parents found', success: false });
        }

        const results = [];

        // 2. Send notification to each parent
        for (const parent of parents) {
            // Get tokens for this user
            const devices = await sql`
        SELECT fcm_token FROM user_devices WHERE user_id = ${parent.user_id}
      `;

            const tokens = devices.map(d => d.fcm_token);

            if (tokens.length > 0) {
                const response = await sendAttendanceNotification(
                    tokens,
                    parent.preferred_language || 'en',
                    student_name || 'Your Child',
                    status
                );
                results.push({ parent: parent.user_id, success: true, count: response.successCount });
            } else {
                results.push({ parent: parent.user_id, success: false, reason: 'No tokens' });
            }
        }

        res.json({ message: 'Notifications processed', results });

    } catch (error) {
        next(error);
    }
});

router.post('/register', async (req, res, next) => {
    try {
        // identifyUser middleware populates req.user
        const { fcm_token, platform } = req.body;
        const user_id = req.user?.id;

        if (!user_id) return res.status(401).json({ error: 'Unauthorized' });
        if (!fcm_token) return res.status(400).json({ error: 'Token required' });

        await sql`
      INSERT INTO user_devices (user_id, fcm_token, platform, last_used_at)
      VALUES (${user_id}, ${fcm_token}, ${platform || 'unknown'}, now())
      ON CONFLICT (user_id, fcm_token) 
      DO UPDATE SET last_used_at = now(), platform = EXCLUDED.platform
    `;

        res.json({ success: true, message: 'Token registered' });
    } catch (error) {
        next(error);
    }
});

router.post('/unregister', async (req, res, next) => {
    try {
        const { fcm_token } = req.body;
        const user_id = req.user?.id;

        if (!user_id) return res.status(401).json({ error: 'Unauthorized' });

        await sql`
      DELETE FROM user_devices WHERE user_id = ${user_id} AND fcm_token = ${fcm_token}
    `;

        res.json({ success: true, message: 'Token unregistered' });
    } catch (error) {
        next(error);
    }
});

export default router;
