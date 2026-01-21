
import admin from '../config/firebase.js';
import sql from '../db.js';

export const sendAttendanceNotification = async (tokens, language = 'en', studentName, status) => {
    if (!tokens || tokens.length === 0) return;

    // Bilingual Content
    const messages = {
        en: {
            title: 'Attendance Alert',
            body: `Your child ${studentName} is marked ${status} today.`
        },
        hi: {
            title: 'उपस्थिति चेतावनी',
            body: `आपके बच्चे ${studentName} को आज ${status} चिह्नित किया गया है।`
        },
        te: {
            title: 'హాజరు హెచ్చరిక',
            body: `మీ బిడ్డ ${studentName} ఈ రోజు ${status} గా గుర్తించబడ్డారు.`
        }
    };

    const content = messages[language] || messages['en'];

    // Determine sound based on status (attendance only logic here)
    let soundName = 'notification_alert'; // default
    let androidChannelId = 'default_channel';

    if (status && status.toLowerCase() === 'absent') {
        soundName = 'attendance_absent_alert';
        androidChannelId = 'absent_channel';
    } else {
        // For present/late etc, user didn't specify, but implies "notification_alert_wav" for others?
        // User said: "if student got absent use attendance_absent_alert.wav else use notification_alert_wav"
        soundName = 'notification_alert';
        androidChannelId = 'default_channel';
    }

    const payload = {
        tokens: tokens,
        notification: {
            title: content.title,
            body: content.body,
        },
        android: {
            notification: {
                channelId: androidChannelId,
                sound: soundName, // no extension for android usually in raw, but let's check expo behavior
                priority: 'high',
                visibility: 'public',
            },
        },
        apns: {
            payload: {
                aps: {
                    sound: soundName + '.wav',
                    contentAvailable: true,
                },
            },
        },
        data: {
            type: 'attendance',
            studentName: studentName,
            status: status,
            language: language,
            android_channel_id: androidChannelId // Pass this for frontend listener if needed
        }
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(payload);
        console.log(`FCM Sent: ${response.successCount} success, ${response.failureCount} failure`);

        // Cleanup invalid tokens
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const err = resp.error;
                    if (err.code === 'messaging/invalid-registration-token' ||
                        err.code === 'messaging/registration-token-not-registered') {
                        failedTokens.push(tokens[idx]);
                    }
                }
            });
            if (failedTokens.length > 0) {
                await sql`DELETE FROM user_devices WHERE fcm_token IN ${sql(failedTokens)}`;
                console.log(`Cleaned up ${failedTokens.length} invalid tokens.`);
            }
        }
        return response;
    } catch (error) {
        console.error('Error sending FCM:', error);
        throw error;
    }
};
