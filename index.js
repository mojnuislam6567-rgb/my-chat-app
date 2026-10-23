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
    databaseURL:
        'https://my-chat-app-eee62-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);
const messaging = getMessaging(firebaseApp);

console.log('Firebase Admin initialized');

app.get('/', (req, res) => {
    res.send('ChatApp Backend is running!');
});

// Send incoming call or new message notification
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

        if (type === 'incoming_audio_call' && !callId) {
            return res.status(400).json({
                error: 'callId is required'
            });
        }

        if (
            decodedToken.uid === receiverUid
        ) {
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

        const title = isCall
            ? 'Incoming Audio Call'
            : (senderName || 'New Message');

        const body = isCall
            ? `${callerName || 'Someone'} is calling you`
            : (message || 'You received a new message');

        const result = await messaging.send({
            token: fcmToken,

            data: {
                type: type,
                callerName: callerName || '',
                callId: callId || '',
                senderName: senderName || '',
                message: message || ''
            },

            android: {
                priority: 'high'
            }
        });

        res.json({
            success: true,
            messageId: result
        });

    } catch (error) {
        console.error('Notification error:', error.message);

        res.status(500).json({
            error: 'Could not send notification'
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
