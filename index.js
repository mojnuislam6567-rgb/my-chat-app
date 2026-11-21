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
    databaseURL:
        'https://my-chat-app-eee62-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);
const messaging = getMessaging(firebaseApp);

console.log('Firebase Admin initialized');

const activeCallMonitors = new Map();

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
            console.log('Call not found:', callId);
            return;
        }

        if (
            call.wasAccepted === true ||
            call.status === 'accepted'
        ) {
            console.log('Call was accepted. No missed notification:', callId);
            return;
        }

        if (
            call.status !== 'ended' &&
            call.status !== 'cancelled' &&
            call.status !== 'canceled'
        ) {
            return;
        }

        // Prevent duplicate notification
        const missedRef = callRef.child('missedNotificationSent');

        const transaction = await missedRef.transaction((current) => {
            if (current === true) {
                return;
            }

            return true;
        });

        if (!transaction.committed) {
            console.log('Already sent:', callId);
            return;
        }

        const tokenSnapshot = await db
            .ref('users/' + receiverUid + '/fcmToken')
            .get();

        const fcmToken = tokenSnapshot.val();

        if (!fcmToken) {
            console.log('Receiver FCM token not found');
            await missedRef.set(false);
            return;
        }

        const profileSnapshot = await db
            .ref('users/' + callerUid + '/profileImage')
            .get();

        const profileImage = profileSnapshot.val() || '';

        await messaging.send({
            token: fcmToken,

            data: {
                type: 'missed_audio_call',
                callerName: callerName || 'Unknown caller',
                callerUid: callerUid || '',
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

        } catch (resetError) {
            console.error('Could not reset flag:', resetError);
        }
    }
}
// ======================================
// WATCH CALL STATUS
// NO 5 MINUTE TIMEOUT
// ======================================

function watchCallForMissedNotification(
    callId,
    receiverUid,
    callerUid,
    callerName
) {
    if (activeCallMonitors.has(callId)) {
        console.log('Monitor already active:', callId);
        return;
    }

    const callRef = db.ref('audioCalls/' + callId);
    const statusRef = callRef.child('status');

    let acceptedSeen = false;
    let notificationHandled = false;
    let listenerRemoved = false;

    function cleanup() {
        if (listenerRemoved) return;

        listenerRemoved = true;

        statusRef.off('value', statusListener);

        activeCallMonitors.delete(callId);
    }

    async function statusListener(snapshot) {

        const status = snapshot.val();

        console.log('Call status:', callId, status);

        // Call accepted
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

        // Rejected call
        if (status === 'rejected') {

            console.log('Call rejected:', callId);

            cleanup();

            return;
        }

        // Call ended
        if (
            status === 'ended' ||
            status === 'cancelled' ||
            status === 'canceled'
        ) {

            if (notificationHandled) return;

            notificationHandled = true;

            cleanup();

            // Answered call should not show missed notification
            if (acceptedSeen) {

                console.log(
                    'Answered call ended. No missed notification:',
                    callId
                );

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

    activeCallMonitors.set(callId, true);

    statusRef.on(
        'value',
        statusListener,
        (error) => {

            console.error('Call status listener error:', error);

            cleanup();
        }
    );
}

// ======================================
// SEND NOTIFICATION API
// ======================================

app.post('/send-notification', async (req, res) => {

    try {

        const authorization = req.headers.authorization || '';

        if (!authorization.startsWith('Bearer ')) {

            return res.status(401).json({
                success: false,
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
        } = req.body || {};

        if (!receiverUid || !type) {

            return res.status(400).json({
                success: false,
                error: 'receiverUid and type are required'
            });
        }

        if (
            type !== 'incoming_audio_call' &&
            type !== 'new_message'
        ) {

            return res.status(400).json({
                success: false,
                error: 'Invalid notification type'
            });
        }

        if (decodedToken.uid === receiverUid) {

            return res.status(400).json({
                success: false,
                error: 'Cannot notify yourself'
            });
        }

        const tokenSnapshot = await db
            .ref('users/' + receiverUid + '/fcmToken')
            .get();

        const fcmToken = tokenSnapshot.val();

        if (!fcmToken) {

            return res.status(404).json({
                success: false,
                error: 'Receiver FCM token not found'
            });
        }

        const isCall = type === 'incoming_audio_call';

        if (isCall && !callId) {

            return res.status(400).json({
                success: false,
                error: 'callId is required'
            });
        }

        let call = null;

        // Verify call
        if (isCall) {

            const callSnapshot = await db
                .ref('audioCalls/' + callId)
                .get();

            call = callSnapshot.val();

            if (
                !call ||
                call.callerUid !== decodedToken.uid ||
                call.receiverUid !== receiverUid
            ) {

                return res.status(403).json({
                    success: false,
                    error: 'Invalid call'
                });
            }

            if (
                call.status !== 'calling' &&
                call.status !== 'ringing'
            ) {

                return res.status(400).json({
                    success: false,
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
                priority: 'high',
                ttl: 60 * 60 * 1000
            }
        });

        // Start call monitor
        // No 5 minute timeout

        if (isCall) {

            watchCallForMissedNotification(
                callId,
                receiverUid,
                decodedToken.uid,
                callerName || 'Unknown caller'
            );
        }

        return res.status(200).json({

            success: true,

            message: 'Notification sent successfully',

            messageId: result
        });

    } catch (error) {

        console.error('Send notification error:', error);

        return res.status(500).json({

            success: false,

            error: 'Failed to send notification'
        });
    }
});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {

    console.log(
        'ChatApp Backend listening on port ' + PORT
    );

}); 
