const express = require('express');
const cors = require('cors');
const fs = require('fs');

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const serviceAccountPath = '/etc/secrets/serviceAccountKey.json';

if (!fs.existsSync(serviceAccountPath)) {
    throw new Error('Firebase service account file not found');
}

const serviceAccount = require(serviceAccountPath);

const firebaseApp = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: 'https://my-chat-app-eee62-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);
const messaging = getMessaging(firebaseApp);

console.log('Firebase Admin initialized');

app.get('/', (req, res) => {
    res.send('ChatApp Backend is running!');
});

app.post('/send-notification', async (req, res) => {
    try {
        const authorization = req.headers.authorization || '';

        if (!authorization.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authentication required'
            });
        }

        const idToken = authorization.substring(7);
        const decodedToken = await auth.verifyIdToken(idToken);

        const {
            receiverUid,
            type,
            callerName,
            callId,
            senderName,
            message
        } = req.body;

        if (!receiverUid || !type) {
            return res.status(400).json({
                error: 'receiverUid and type are required'
            });
        }

        if (
            type !== 'incoming_audio_call' &&
            type !== 'new_message'
        ) {
            return res.status(400).json({
                error: 'Invalid notification type'
            });
        }

        if (decodedToken.uid === receiverUid) {
            return res.status(400).json({
                error: 'Cannot notify yourself'
            });
        }

        const tokenSnapshot = await db
            .ref(`users/${receiverUid}/fcmToken`)
            .get();

        const fcmToken = tokenSnapshot.val();

        if (!fcmToken) {
            return res.status(404).json({
                error: 'Receiver FCM token not found'
            });
        }

        const isCall = type === 'incoming_audio_call';

        if (isCall && !callId) {
            return res.status(400).json({
                error: 'callId is required'
            });
        }

        if (isCall) {
            const callSnapshot = await db
                .ref(`audioCalls/${callId}`)
                .get();

            const call = callSnapshot.val();

            if (
                !call ||
                call.callerUid !== decodedToken.uid ||
                call.receiverUid !== receiverUid
            ) {
                return res.status(403).json({
                    error: 'Invalid call'
                });
            }
        }

        const result = await messaging.send({
            token: fcmToken,
            data: {
                type,
                callerName: callerName || '',
                callId: callId || '',
                callerUid: decodedToken.uid,
                senderName: senderName || '',
                message: message || ''
            },
            android: {
                priority: 'high'
            }
        });

        // কলের ৩০ সেকেন্ড পর Missed Call পরীক্ষা
        if (isCall) {
            setTimeout(async () => {
                try {
                    const callRef = db.ref(`audioCalls/${callId}`);
                    const callSnapshot = await callRef.get();
                    const call = callSnapshot.val();

                    if (
    !call ||
    (call.status !== 'calling' && call.status !== 'ringing') ||
    call.receiverUid !== receiverUid
) {
    console.log('Call was answered or ended:', callId);
    return;
}

                    // একই কলের জন্য একবারই Missed Notification
                    const missedRef = callRef.child('missedNotificationSent');

                    const transaction = await missedRef.transaction(
                        current => current === true ? undefined : true
                    );

                    if (!transaction.committed) {
                        return;
                    }

                    const latestTokenSnapshot = await db
                        .ref(`users/${receiverUid}/fcmToken`)
                        .get();

                    const latestToken = latestTokenSnapshot.val();

                    if (!latestToken) return;

                    const profileSnapshot = await db
                        .ref(`users/${decodedToken.uid}/profileImage`)
                        .get();

                    const profileImage = profileSnapshot.val() || '';

                    await messaging.send({
                        token: latestToken,
                        data: {
                            type: 'missed_audio_call',
                            callerName: callerName || 'Unknown caller',
                            callerUid: decodedToken.uid,
                            callId: callId,
                            profileImage: profileImage
                        },
                        android: {
                            priority: 'high',
                            ttl: 60 * 60 * 1000
                        }
                    });

                    console.log('Missed call notification sent:', callId);

                } catch (error) {
                    console.error('Missed call error:', error);
                }
            }, 30000);
        }

        res.json({
            success: true,
            messageId: result
        });

    } catch (error) {
        console.error('Notification error:', error);

        res.status(500).json({
            error: 'Could not send notification'
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
