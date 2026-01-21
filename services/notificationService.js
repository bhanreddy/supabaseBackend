
import admin from '../config/firebase.js';
import sql from '../db.js';

export const sendAttendanceNotification = async (
    tokens,
    language = 'en',
    studentName,
    status
) => {
    if (!tokens || tokens.length === 0) return;

    const messages = {
        en: {
            title: 'Attendance Alert',
            body: `${studentName} is marked ${status} today.`,
            voice: `${studentName} is ${status} today.`
        },
        hi: {
            title: 'उपस्थिति सूचना',
            body: `${studentName} आज ${status} है।`,
            voice: `${studentName} आज ${status} है।`
        },
        te: {
            title: 'హాజరు సమాచారం',
            body: `${studentName} ఈ రోజు ${status}.`,
            voice: `${studentName} ఈ రోజు ${status}.`
        }
    };

    const content = messages[language] || messages.en;

    const isAbsent = status?.toLowerCase() === 'absent';

    const soundName = isAbsent
        ? 'attendance_absent_alert'
        : 'notification_alert';

    const androidChannelId = isAbsent
        ? 'attendance_absent_channel'
        : 'attendance_default_channel';

    const payload = {
        tokens,
        notification: {
            title: content.title,
            body: content.body
        },
        android: {
            notification: {
                channelId: androidChannelId,
                sound: soundName,
                priority: 'high',
                visibility: 'public',
                tag: `attendance_${studentName}`
            }
        },
        apns: {
            payload: {
                aps: {
                    sound: `${soundName}.wav`,
                    'content-available': 1
                }
            }
        },
        data: {
            type: 'attendance',
            studentName,
            status,
            language,
            voiceText: content.voice,
            channelId: androidChannelId
        }
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(payload);

        if (response.failureCount > 0) {
            const failedTokens = response.responses
                .map((r, i) => (!r.success ? tokens[i] : null))
                .filter(Boolean);

            if (failedTokens.length) {
                await sql`
          DELETE FROM user_devices
          WHERE fcm_token IN ${sql(failedTokens)}
        `;
            }
        }

        return response;
    } catch (err) {
        console.error('FCM Error:', err);
        throw err;
    }
};
