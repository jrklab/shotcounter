'use strict';

import { onAuthChange, signInWithGoogle, signInWithEmail,
         signUpWithEmail, signOut, resetPassword } from './auth.js';
import { S }                                       from './state.js';
import { showScreen, showToast }                   from './utils.js';

// ── Auth screen ───────────────────────────────────────────────────────────────
export function wireAuthScreen() {
  const emailInput  = document.getElementById('auth-email');
  const pwInput     = document.getElementById('auth-password');
  const googleBtn   = document.getElementById('auth-google-btn');
  const emailSignIn = document.getElementById('auth-email-signin');
  const emailSignUp = document.getElementById('auth-email-signup');
  const resetBtn    = document.getElementById('auth-reset-btn');
  const authError   = document.getElementById('auth-error');
  const authTab     = document.querySelectorAll('.auth-tab');

  authTab.forEach(tab => tab.addEventListener('click', () => {
    authTab.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    emailSignIn.style.display = mode === 'signin' ? '' : 'none';
    emailSignUp.style.display = mode === 'signup' ? '' : 'none';
    resetBtn.style.display    = mode === 'signin' ? '' : 'none';
    authError.textContent     = '';
  }));

  googleBtn.addEventListener('click', async () => {
    authError.textContent = '';
    try { await signInWithGoogle(); } catch (e) { authError.textContent = friendlyAuthError(e); }
  });

  emailSignIn.addEventListener('click', async () => {
    authError.textContent = '';
    const email = emailInput.value.trim();
    const pw    = pwInput.value;
    if (!email || !pw) { authError.textContent = 'Enter email and password.'; return; }
    try { await signInWithEmail(email, pw); } catch (e) { authError.textContent = friendlyAuthError(e); }
  });

  emailSignUp.addEventListener('click', async () => {
    authError.textContent = '';
    const email = emailInput.value.trim();
    const pw    = pwInput.value;
    if (!email || !pw) { authError.textContent = 'Enter email and password.'; return; }
    if (pw.length < 6) { authError.textContent = 'Password must be at least 6 characters.'; return; }
    try { await signUpWithEmail(email, pw); } catch (e) { authError.textContent = friendlyAuthError(e); }
  });

  resetBtn?.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) { authError.textContent = 'Enter your email first.'; return; }
    try {
      await resetPassword(email);
      authError.style.color = '#2ecc71';
      authError.textContent = 'Password reset email sent.';
      setTimeout(() => { authError.style.color = ''; authError.textContent = ''; }, 4000);
    } catch (e) { authError.textContent = friendlyAuthError(e); }
  });
}

function friendlyAuthError(e) {
  const code = e.code ?? '';
  if (code.includes('wrong-password') || code.includes('invalid-credential'))
    return 'Incorrect email or password.';
  if (code.includes('user-not-found'))  return 'No account with that email.';
  if (code.includes('email-already'))   return 'Email already registered — sign in instead.';
  if (code.includes('invalid-email'))   return 'Enter a valid email address.';
  if (code.includes('popup-closed'))    return 'Sign-in popup was closed.';
  return e.message ?? 'Sign-in failed.';
}

// ── Auth state listener ───────────────────────────────────────────────────────
export function startAuthListener() {
  onAuthChange(u => {
    S.user = u;
    if (u) {
      showScreen('dashboard');
      const nameEl   = document.getElementById('dash-user-name');
      const avatarEl = document.getElementById('dash-user-avatar');
      if (nameEl)   nameEl.textContent = u.displayName || u.email || 'User';
      if (avatarEl && u.photoURL) { avatarEl.src = u.photoURL; avatarEl.style.display = 'block'; }
    } else {
      showScreen('auth');
    }
  });
}
