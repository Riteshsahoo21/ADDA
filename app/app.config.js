const fs = require('node:fs');
const path = require('node:path');
const { expo } = require('./app.json');

// Local releases still build before Firebase is configured. Supplying the
// Firebase Android config enables FCM token registration in that build.
const googleServices = path.join(__dirname, 'google-services.json');
if (fs.existsSync(googleServices)) expo.android.googleServicesFile = './google-services.json';

module.exports = { expo };
