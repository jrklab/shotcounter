/**
 * firebase.js
 * Initializes Firebase app and exports shared service instances.
 * Uses the Firebase Modular SDK v11 from the Google CDN (no bundler needed).
 */

import { initializeApp }    from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getAuth }          from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { getFirestore }     from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { getStorage }       from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js';

const firebaseConfig = {
  apiKey:            'AIzaSyAB5-_z8v1P8p79bPc2WvH3k3m86Ds-zuI',
  authDomain:        'basketball-tracker-data.firebaseapp.com',
  projectId:         'basketball-tracker-data',
  storageBucket:     'basketball-tracker-data.firebasestorage.app',
  messagingSenderId: '433195026716',
  appId:             '1:433195026716:web:7072995f00768232e812d9',
  measurementId:     'G-PB1ZGDNLJE',
};

const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);
const storage = getStorage(app);

export { app, auth, db, storage };
