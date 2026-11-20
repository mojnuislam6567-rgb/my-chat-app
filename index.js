```javascript
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


// ======================================
// MISSED CALL NOTIFICATION
// ======================================

async function sendMissedCallNotification(
    callId,
    receiverUid,
    callerUid,
    callerName
) {
    const callRef = db.ref(`audioCalls/${callId}`);

    try {
        const callSnapshot = await callRef.get();
        const call = callSnapshot.val();

        if (!call) return;

        // কল রিসিভ করা হলে Missed Call যাবে না
        if (
            call.status === 'accepted' ||
            call.wasAccepted === true
        ) {
            console.log('Call was accepted. No missed notification:', callId);
            return;
        }

        // শুধু শেষ হওয়া কলের জন্য notification
        if (
            call.status !== 'ended' &&
            call.status !== 'cancelled' &&
            call.status !== 'canceled'
        ) {
            return;
        }

        // একই কলের notification একবারই যাবে
        const missedRef = callRef.child('missedNotificationSent');

        const transaction = await missedRef.transaction(current => {
            if (current === true) {
                return;
            }

            return true;
        });

        if (!transaction.committed) {
            console.log('Missed notification already sent:', callId);
            return;
        }

        const tokenSnapshot = await db
            .ref(`users/${receiverUid}/fcmToken`)
            .get();

        const fcmToken = tokenSnapshot.val();

        if (!fcmToken) {
            console.log('Receiver FCM token not found:', receiverUid);
            await missedRef.set(false);
            return;
        }

        const profileSnapshot = await db
            .ref(`users/${callerUid}/profileImage`)
            .get();

        const profileImage = profileSnapshot.val() || '';

        await messaging.send({
            token: fcmToken,

            data: {
                type: 'missed_audio_call',
                callerName: callerName || 'Unknown caller',
                callerUid: callerUid,
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
        console.error('Missed call notification error:', error);

        try {
            await callRef
                .child('missedNotificationSent')
                .set(false);
        } catch (e) {
            console.error('Could not reset missed notification flag:', e);
        }
    }
}


// ======================================
// WATCH CALL STATUS
// ======================================

function watchCallForMissedNotification(
    callId,
    receiverUid,
    callerUid,
    callerName
) {
    const callRef = db.ref(`audioCalls/${callId}`);
    const statusRef = callRef.child('status');

    let acceptedSeen = false;
    let notificationHandled = false;
    let listenerRemoved = false;
    let timeout = null;

    const cleanup = () => {
        if (listenerRemoved) return;

        listenerRemoved = true;

        statusRef.off('value', statusListener);

        if (timeout !== null) {
            clearTimeout(timeout);
        }
    };

    const statusListener = async snapshot => {
        const status = snapshot.val();

        console.log('Call status changed:', callId, status);

        // Receiver কল ধরেছে
        if (status === 'accepted') {
            acceptedSeen = true;

            await callRef.child('wasAccepted').set(true);

            return;
        }

        // কল শেষ হয়েছে
        if (
            status === 'ended' ||
            status === 'cancelled' ||
            status === 'canceled'
        ) {
            if (notificationHandled) return;

            notificationHandled = true;

            cleanup();

            // আগে কল রিসিভ করা হয়ে থাকলে notification নয়
            if (acceptedSeen) {
                console.log('Answered call ended. No missed call:', callId);
                return;
            }

            await sendMissedCallNotification(
                callId,
                receiverUid,
                callerUid,
                callerName
            );

            return;
        }

        // Receiver নিজে Decline করলে Missed Call নয়
        if (status === 'rejected') {
            console.log('Receiver rejected the call:', callId);
            cleanup();
        }
    };

    // Firebase status listener
    statusRef.on('value', statusListener, error => {
        console.error('Call status listener error:', error);
    });

    // ৫ মিনিট পর unanswered call শেষ হবে
    timeout = setTimeout(async () => {
        try {
            const transaction = await callRef.transaction(current => {
                if (!current) return;

                // কল ইতিমধ্যে শেষ বা রিসিভ হলে কিছু করবে না
                if (
                    current.status !== 'calling' &&
                    current.status !== 'ringing'
                ) {
                    return;
                }

                if (current.wasAccepted === true) {
                    return;
                }

                current.status = 'ended';
                current.endedReason = 'timeout';

                return current;
            });

            if (transaction.committed) {
                console.log('Unanswered call ended after 5 minutes:', callId);
            } else {
                console.log('Call already answered or ended:', callId);
            }

        } catch (error) {
            console.error('Call timeout error:', error);
        }

    }, 5 * 60 * 1000);
}


// ======================================
// SEND NOTIFICATION API
// ======================================

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

            if (
                call.status !== 'calling' &&
                call.status !== 'ringing'
            ) {
                return res.status(400).json({
                    error: 'Call is not ringing'
                });
            }
        }

        // Incoming notification পাঠানো
        const result = await messaging.send({
            token: fcmToken,

            data: {
                type: type,
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

        // Call status monitor শুরু
        if (isCall) {
            watchCallForMissedNotification(
                callId,
                receiverUid,
                decodedToken.uid,
                callerName || 'Unknown caller'
            );
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


// ======================================
// START SERVER
// ======================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
```
