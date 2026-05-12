// Save-and-Publish Draft Editor
//
// This app has a known race condition between /draft and /publish.
// See README.md for the bug description and what you're being asked to do.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// ---------------------------------------------------------------------------
// Debug instrumentation
// ---------------------------------------------------------------------------
// Set DEBUG_RACE=1 to enable timestamped logging of handler entry/exit and
// state transitions. Leave off in production; controlled via env var.
const DEBUG = process.env.DEBUG_RACE === '1';

function log(tag, msg, extra) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const payload = extra !== undefined ? ` | ${JSON.stringify(extra)}` : '';
  console.log(`[${ts}] [${tag}] ${msg}${payload}`);
}

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------
// `currentDraft` is the most recent saved draft.
// `publishedDraft` is what /publish has marked as live.
//
// In a real app these would live in a database. For this assignment, in-memory
// is fine — the bug is in the timing, not the storage.
let currentDraft = '';
let publishedDraft = '';

// `pendingSave` tracks the most recent in-flight /draft request.
// It is a Promise that resolves once the save has committed to currentDraft.
// Starts as an already-resolved promise so publish works even before any save.
// FIX: /publish awaits this before reading currentDraft, ensuring it always
// sees the most recently initiated save, not a stale committed value.
let pendingSave = Promise.resolve();

// SAVE_COMMIT_DELAY_MS controls how long a /draft request takes to commit.
// In production this would represent database write latency, network latency,
// or any other delay between "request received" and "value updated."
//
// Set to 200ms by default to make the race condition reliably reproducible.
// Tests may override this via environment variable.
const SAVE_COMMIT_DELAY_MS = parseInt(process.env.SAVE_COMMIT_DELAY_MS || '200', 10);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /draft — save the current draft text.
//
// Note the artificial delay: the draft is not committed to currentDraft
// until SAVE_COMMIT_DELAY_MS milliseconds after the request arrives.
app.post('/draft', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  log('SAVE', 'request received', { content, currentDraftBefore: currentDraft });

  // Simulate write latency.
  // FIX: wrap the timeout in a Promise and assign it to pendingSave so that
  // /publish can await it before reading currentDraft.
  // Only the most recent save is tracked (last-write-wins semantics).
  pendingSave = new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const prev = currentDraft;
        currentDraft = content;
        log('SAVE', 'committed to currentDraft', { content, prevDraft: prev, currentDraftAfter: currentDraft });
        resolve();
        res.json({ ok: true, saved: content });
      } catch (err) {
        reject(err);
      }
    }, SAVE_COMMIT_DELAY_MS);
  });
});

// POST /publish — mark the most recent saved draft as live.
//
// FIX: await pendingSave before reading currentDraft. This ensures that if a
// /draft request is in flight when publish arrives, publish will block until
// the save commits, then read the freshly committed value.
app.post('/publish', async (req, res) => {
  log('PUBLISH', 'request received — awaiting any in-flight save', { currentDraftBeforeAwait: currentDraft });
  // Assumption: saves always resolve (setTimeout always fires).
  // In production, add a Promise.race with a deadline to avoid indefinite blocking.
  await pendingSave.catch((err) => {
    log('PUBLISH', 'pendingSave rejected — proceeding with current state', { err: err.message });
  });
  log('PUBLISH', 'pendingSave resolved — reading currentDraft', { currentDraftAfterAwait: currentDraft });
  publishedDraft = currentDraft;
  log('PUBLISH', 'published', { publishedDraft });
  res.json({ ok: true, published: publishedDraft });
});

// GET /published — return the currently published draft.
app.get('/published', (req, res) => {
  res.json({ published: publishedDraft });
});

// GET /current — return the currently saved (committed) draft.
app.get('/current', (req, res) => {
  res.json({ current: currentDraft });
});

// Reset endpoint for tests.
app.post('/reset', (req, res) => {
  log('RESET', 'state cleared');
  currentDraft = '';
  publishedDraft = '';
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Draft editor running on http://localhost:${PORT}`);
    console.log(`SAVE_COMMIT_DELAY_MS = ${SAVE_COMMIT_DELAY_MS}`);
    console.log(`DEBUG_RACE = ${process.env.DEBUG_RACE || '0'}`);
  });
}

module.exports = app;
