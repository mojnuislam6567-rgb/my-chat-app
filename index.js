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


// ======================================
// FIREBASE INITIALIZATION
// ======================================

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


// ======================================
// HOME
// ======================================

app.get('/', (req, res) => {
    res.send('ChatApp Backend is running!');
});


// ======================================
// SEND MISSED CALL NOTIFICATION
// ======================================

async function sendMissedCallNotification(
    callId,
    receiverUid,
    callerUid,
    callerName
) {
    const callRef = db.ref('audioCalls/' + callId);

    try {
        const snapshot = await callRef.get();
        const call = snapshot.val();

        if (!call) {
            return;
        }

        // Accepted call হলে Missed Call পাঠাবে না
        if (
            call.wasAccepted === true ||
            call.status === 'accepted'
        ) {
            console.log('Call was accepted. No missed notification:', callId);
            return;
        }

        // শুধু শেষ হওয়া কলের জন্য
        if (
            call.status !== 'ended' &&
            call.status !== 'cancelled' &&
            call.status !== 'canceled'
        ) {
            return;
        }

        // Duplicate notification আটকানো
        const missedRef = callRef.child('missedNotificationSent');

        const transaction = await missedRef.transaction(function(current) {
            if (current === true) {
                return;
            }

            return true;
        });

        if (!transaction.committed) {
            console.log('Missed notification already sent:', callId);
            return;
        }

        // Receiver-এর FCM token
        const tokenSnapshot = await db
            .ref('users/' + receiverUid + '/fcmToken')
            .get();

        const fcmToken = tokenSnapshot.val();

        if (!fcmToken) {
            console.log('Receiver FCM token not found');

            await missedRef.set(false);
            return;
        }

        // Caller-এর profile image
        const profileSnapshot = await db
            .ref('users/' + callerUid + '/profileImage')
            .get();

        const profileImage = profileSnapshot.val() || '';

        // Missed Call notification
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
                ttl: 3600000
            }
        });

        console.log('Missed call notification sent:', callId);

    } catch (error) {
        console.error('Missed call notification error:', error);

        try {
            await callRef
                .child('missedNotificationSent')
                .set(false);
        } catch (resetError) {
            console.error('Could not reset notification flag:', resetError);
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
    const callRef = db.ref('audioCalls/' + callId);
    const statusRef = callRef.child('status');

    let acceptedSeen = false;
    let notificationHandled = false;
    let listenerRemoved = false;
    let timeout = null;

    function cleanup() {
        if (listenerRemoved) {
            return;
        }

        listenerRemoved = true;

        statusRef.off('value', statusListener);

        if (timeout !== null) {
            clearTimeout(timeout);
        }
    }

    async function statusListener(snapshot) {
        const status = snapshot.val();

        console.log('Call status:', callId, status);

        // Receiver কল রিসিভ করেছে
        if (status === 'accepted') {
            acceptedSeen = true;

            try {
                await callRef.child('wasAccepted').set(true);
                console.log('Call accepted:', callId);
            } catch (error) {
                console.error('Could not save accepted status:', error);
            }

            return;
        }

        // Receiver নিজে Decline করেছে
        if (status === 'rejected') {
            console.log('Call rejected:', callId);
            cleanup();
            return;
        }

        // Caller অথবা অন্য কারণে কল শেষ হয়েছে
        if (
            status === 'ended' ||
            status === 'cancelled' ||
            status === 'canceled'
        ) {
            if (notificationHandled) {
                return;
            }

            notificationHandled = true;

            cleanup();

            // আগে কল রিসিভ হয়ে থাকলে Missed Call নয়
            if (acceptedSeen) {
                console.log('Answered call ended. No missed notification:', callId);
                return;
            }

            await sendMissedCallNotification(
                callId,
                receiverUid,
                callerUid,
                callerName
            );
        }
    }

    // Firebase listener
    statusRef.on(
        'value',
        statusListener,
        function(error) {
            console.error('Call status listener error:', error);
        }
    );

    // ======================================
    // 5 MINUTE CALL TIMEOUT
    // ======================================

    timeout = setTimeout(async function() {
        try {
            const transaction = await callRef.transaction(function(current) {
                if (!current) {
                    return;
                }

                // কল ইতিমধ্যে শেষ হলে কিছু করবে না
                if (
                    current.status !== 'calling' &&
                    current.status !== 'ringing'
                ) {
                    return;
                }

                // Accepted call শেষ করবে না
                if (current.wasAccepted === true) {
                    return;
                }

                current.status = 'ended';
                current.endedReason = 'timeout';

                return current;
            });

            if (transaction.committed) {
                console.log('Call ended after 5 minutes:', callId);
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
            .ref('users/' + receiverUid + '/fcmToken')
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

        // ======================================
        // VERIFY CALL
        // ======================================

        if (isCall) {
            const callSnapshot = await db
                .ref('audioCalls/' + callId)
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

        // ======================================
        // SEND FCM NOTIFICATION
        // ======================================

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

        // ======================================
        // START CALL MONITOR
