const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const serviceAccountPath = '/etc/secrets/serviceAccountKey.json';

if (fs.existsSync(serviceAccountPath)) {
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
credential: admin.credential.cert(serviceAccount),
databaseURL: 'https://my-chat-app-eee62-default-rtdb.asia-southeast1.firebasedatabase.app'
});

console.log('Firebase Admin initialized');
} else {
console.error('Firebase service account file not found');
}

app.get('/', (req, res) => {
res.send('ChatApp Backend is running!');
});

app.listen(PORT, '0.0.0.0', () => {
console.log('Server running on port ' + PORT);
});
