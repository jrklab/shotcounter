/**
 * video-store.js
 * IndexedDB wrapper for full-session video storage.
 *
 * The full MediaRecorder output is stored here during the practice session so
 * it survives the in-RAM rolling buffer limit.  The review screen loads the
 * blob back and seeks to each event's host timestamp instead of using
 * pre-extracted per-shot clips.
 *
 * Schema:
 *   DB: shotcounter-video  v1
 *   Object store: sessions  (key = sessionId string)
 *   Value: Blob  (full-session WebM video)
 */

'use strict';

const DB_NAME    = 'shotcounter-video';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/**
 * Save (or overwrite) a full-session video blob.
 * @param {string} sessionId
 * @param {Blob}   blob
 */
export async function storeSessionVideo(sessionId, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

/**
 * Retrieve the stored video blob for a session.
 * Returns undefined if not found.
 * @param {string} sessionId
 * @returns {Promise<Blob|undefined>}
 */
export async function loadSessionVideo(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(sessionId);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/**
 * Delete the stored video blob for a session (call after successful upload).
 * @param {string} sessionId
 */
export async function deleteSessionVideo(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}
