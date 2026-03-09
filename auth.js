/**
 * auth.js
 * Firebase Authentication helpers — Google Sign-In + Email/Password.
 *
 * Exports:
 *   signInWithGoogle()          — opens Google popup
 *   signInWithEmail(email, pw)  — email/password sign-in
 *   signUpWithEmail(email, pw)  — new account registration
 *   signOut()
 *   onAuthChange(callback)      — subscribe to auth state
 *   currentUser()               — synchronous snapshot of current user
 */

import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as _signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

import { auth } from './firebase.js';

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// ── Sign-in methods ─────────────────────────────────────────────────────────

export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signUpWithEmail(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signOut() {
  await _signOut(auth);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

// ── Auth state ──────────────────────────────────────────────────────────────

/** @param {(user: import('firebase/auth').User | null) => void} callback */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function currentUser() {
  return auth.currentUser;
}
