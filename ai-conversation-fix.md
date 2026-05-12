# AI Conversation — Producing the Fix

## Context

This document records the AI-assisted debugging session that produced the fix for the
save/publish race condition in `app/server.js`.

---

## Step 1 — Trace as evidence

Before asking AI to fix anything, I ran the harness against the instrumented (broken) app
and captured `trace.txt`. The key lines that show the race:

```
[2026-05-12T02:39:23.422Z] [HARNESS] save B is now IN-FLIGHT; server will commit in ~200ms

[2026-05-12T02:39:23.482Z] [HARNESS] step 3 — firing publish after 50ms
[2026-05-12T02:39:23.482Z] [HARNESS] save B has been in-flight for ~60ms (commit delay: 200ms)
[2026-05-12T02:39:23.483Z] [HARNESS] RACE: publish is reading currentDraft right now — before save B has committed
[2026-05-12T02:39:23.492Z] [HARNESS] publish responded: {"ok":true,"published":"draft A"}

[2026-05-12T02:39:23.635Z] [HARNESS] save B finally committed — response: {"ok":true,"saved":"draft B"}

RESULT: FAIL — RACE CONDITION CONFIRMED
  expected published = "draft B"
  actual   published = "draft A"
  publish read stale currentDraft because save B had not yet committed
```

The trace proves: publish arrived 60ms after the save request, but the save's 200ms commit
delay had not elapsed. Publish read `currentDraft` at that moment and got the old value
("draft A"). The correct value ("draft B") committed 153ms later — after publish had
already responded.

---

## Step 2 — Prompt to AI

**My prompt (directed at AI, citing the trace as evidence):**

> The trace shows the race condition clearly:
>
> - `/draft` for "draft B" was sent at `02:39:23.422Z`
> - `/publish` fired just 60ms later at `02:39:23.482Z`
> - The save's commit delay is 200ms, so `currentDraft` still held "draft A" at publish time
> - Publish responded with `"draft A"` (stale)
> - Save B only committed at `02:39:23.635Z` — 153ms after publish ran
>
> The bug is in `app/server.js`: `POST /publish` reads `currentDraft` immediately, with
> no awareness of any in-flight save.
>
> Fix this so that `/publish` always reflects the most recently *initiated* save, even if
> that save has not yet committed. The fix must not break the no-race case (publish with
> no save in flight). Commit the fix separately from the instrumentation.

---

## Step 3 — AI's reasoning and fix

AI identified the core issue: `currentDraft` is a plain variable written inside a
`setTimeout` callback. There is no coordination between the writer (the save handler) and
the reader (the publish handler). Any call to publish that arrives during the 200ms delay
window reads the old value.

**AI's proposed fix (which I applied verbatim):**

1. Add a module-level `pendingSave` variable initialised to `Promise.resolve()` — an
   already-resolved promise, so publish works with no prior saves.

2. In the `/draft` handler, wrap the `setTimeout` in a `new Promise`. Assign it to
   `pendingSave` before returning. The promise resolves after the save commits (inside
   the timeout), not when the request arrives.

3. Change `/publish` to `async` and add `await pendingSave` as the first thing it does.
   This ensures that if a save is in flight when publish arrives, publish blocks until
   the save commits, then reads the freshly committed value.

**The resulting changes to `app/server.js`:**

```diff
+let pendingSave = Promise.resolve();

 app.post('/draft', (req, res) => {
   ...
-  setTimeout(() => {
-    currentDraft = content;
-    res.json({ ok: true, saved: content });
-  }, SAVE_COMMIT_DELAY_MS);
+  pendingSave = new Promise((resolve) => {
+    setTimeout(() => {
+      currentDraft = content;
+      resolve();
+      res.json({ ok: true, saved: content });
+    }, SAVE_COMMIT_DELAY_MS);
+  });
 });

-app.post('/publish', (req, res) => {
-  publishedDraft = currentDraft;
-  res.json({ ok: true, published: publishedDraft });
-});
+app.post('/publish', async (req, res) => {
+  await pendingSave;
+  publishedDraft = currentDraft;
+  res.json({ ok: true, published: publishedDraft });
+});
```

---

## Step 4 — Verification

After applying the fix I re-ran the harness and the regression tests:

**Harness output (fixed):**
```
[HARNESS] save B has been in-flight for ~59ms (commit delay: 200ms)
[HARNESS] RACE: publish is reading currentDraft right now — before save B has committed
[HARNESS] publish responded: {"ok":true,"published":"draft B"}

RESULT: PASS — publish correctly reflects the most recent (in-flight) save
```

**npm test output (fixed):**
```
# pass 2
# fail 0
```

Both tests pass. The harness confirms correct behaviour under the race scenario.
The fix correctly serialises publish behind the most recent save without breaking
the no-race path.
