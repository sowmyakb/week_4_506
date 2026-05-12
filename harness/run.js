// Race-condition harness for the save/publish draft editor.
//
// This script drives the app's HTTP endpoints to force the race between
// POST /draft and POST /publish to fire deterministically.
//
// Scenario (mirrors the user story in the bug description):
//   1. Save "draft A"  — wait for it to fully commit so baseline state is known.
//   2. Save "draft B"  — do NOT wait; the save is now in-flight.
//   3. Publish         — fire immediately while save B is still in-flight.
//   4. Read /published — what did publish actually record?
//
// A correct implementation publishes "draft B".
// The broken implementation publishes "draft A" (stale state).
//
// Usage:
//   node harness/run.js
//
// The app must be running with DEBUG_RACE=1 on port 3000.  The harness will
// spin up its own in-process server if the environment variable RUN_INLINE
// is set to 1 (used when capturing trace.txt so you don't need a separate
// terminal).

'use strict';

const http = require('http');

// ---- configuration --------------------------------------------------------
const HOST = 'localhost';
const PORT = 3000;
// How long save B's artificial delay is.  Must match SAVE_COMMIT_DELAY_MS on
// the server (default 200ms).  We fire publish after PUBLISH_FIRE_AFTER_MS,
// which must be shorter than SAVE_COMMIT_DELAY_MS to guarantee the race.
const SAVE_COMMIT_DELAY_MS = parseInt(process.env.SAVE_COMMIT_DELAY_MS || '200', 10);
const PUBLISH_FIRE_AFTER_MS = 50; // well inside the delay window

// ---- helpers ---------------------------------------------------------------
function ts() {
  return new Date().toISOString();
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: HOST,
      port: PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: HOST, port: PORT, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- main ------------------------------------------------------------------
async function run() {
  console.log('='.repeat(70));
  console.log('RACE CONDITION HARNESS');
  console.log(`SAVE_COMMIT_DELAY_MS = ${SAVE_COMMIT_DELAY_MS}ms`);
  console.log(`PUBLISH fires ${PUBLISH_FIRE_AFTER_MS}ms after save B is sent`);
  console.log(`(publish fires BEFORE save B commits — race is forced)`);
  console.log('='.repeat(70));

  // --- reset ----------------------------------------------------------------
  console.log(`\n[${ts()}] [HARNESS] resetting server state`);
  await post('/reset', {});
  console.log(`[${ts()}] [HARNESS] reset complete — currentDraft='', publishedDraft=''`);

  // --- step 1: save A and wait for full commit ------------------------------
  console.log(`\n[${ts()}] [HARNESS] step 1 — sending save "draft A" and awaiting commit`);
  const saveA = await post('/draft', { content: 'draft A' });
  console.log(`[${ts()}] [HARNESS] save A committed — response: ${JSON.stringify(saveA.body)}`);

  // --- step 2: send save B (do NOT await) -----------------------------------
  console.log(`\n[${ts()}] [HARNESS] step 2 — sending save "draft B" (NOT awaiting)`);
  console.log(`[${ts()}] [HARNESS] save B is now IN-FLIGHT; server will commit in ~${SAVE_COMMIT_DELAY_MS}ms`);
  const saveBStart = Date.now();
  const saveBPromise = post('/draft', { content: 'draft B' });

  // --- step 3: publish fires before save B commits --------------------------
  await sleep(PUBLISH_FIRE_AFTER_MS);
  console.log(`\n[${ts()}] [HARNESS] step 3 — firing publish after ${PUBLISH_FIRE_AFTER_MS}ms`);
  console.log(`[${ts()}] [HARNESS] save B has been in-flight for ~${Date.now() - saveBStart}ms (commit delay: ${SAVE_COMMIT_DELAY_MS}ms)`);
  console.log(`[${ts()}] [HARNESS] RACE: publish is reading currentDraft right now — before save B has committed`);
  const publishResult = await post('/publish', {});
  console.log(`[${ts()}] [HARNESS] publish responded: ${JSON.stringify(publishResult.body)}`);

  // --- wait for save B to finish --------------------------------------------
  const saveB = await saveBPromise;
  console.log(`\n[${ts()}] [HARNESS] save B finally committed — response: ${JSON.stringify(saveB.body)}`);

  // --- step 4: read final state --------------------------------------------
  const published = await get('/published');
  const current = await get('/current');
  console.log(`\n[${ts()}] [HARNESS] final state:`);
  console.log(`  /current   = "${current.body.current}"`);
  console.log(`  /published = "${published.body.published}"`);

  // --- verdict --------------------------------------------------------------
  console.log('\n' + '='.repeat(70));
  const expected = 'draft B';
  const actual = published.body.published;
  if (actual === expected) {
    console.log('RESULT: PASS — publish correctly reflects the most recent (in-flight) save');
  } else {
    console.log('RESULT: FAIL — RACE CONDITION CONFIRMED');
    console.log(`  expected published = "${expected}"`);
    console.log(`  actual   published = "${actual}"`);
    console.log('  publish read stale currentDraft because save B had not yet committed');
  }
  console.log('='.repeat(70));
}

run().catch((err) => {
  console.error(`[${ts()}] [HARNESS] ERROR: ${err.message}`);
  console.error('Is the app running? Start it with: DEBUG_RACE=1 npm start');
  process.exit(1);
});
