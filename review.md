# Code Review — Fix for Save/Publish Race Condition

## The fix being reviewed

The diff below is what was committed to resolve the race condition in `app/server.js`.

```diff
+// `pendingSave` tracks the most recent in-flight /draft request.
+// It is a Promise that resolves once the save has committed to currentDraft.
+// Starts as an already-resolved promise so publish works even before any save.
+// FIX: /publish awaits this before reading currentDraft, ensuring it always
+// sees the most recently initiated save, not a stale committed value.
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

## Review prompt

> Review this fix critically. Look for: failure modes it doesn't address, edge cases
> missed, assumptions it makes about the system, alternative approaches that might be
> cleaner, anything a senior engineer would push back on. Be thorough. Assume the code
> has problems and find them.

---

## AI Reviewer's Full Response

**Point 1 — Only the most recent save is tracked; concurrent saves lose coordination.**

`pendingSave` is a single module-level variable. If two `/draft` requests arrive close
together, the second one overwrites `pendingSave` before the first has resolved. Any
`/publish` that arrives between them will only await the *second* save, not the first.
In this app that is actually the *correct* semantics — "publish the most recent draft" —
but the code doesn't make that intent explicit. A reader might reasonably wonder whether
the first save is lost or whether there's a queue somewhere.

**Point 2 — Publish can be delayed indefinitely by a long or hung save.**

If a `/draft` request's `setTimeout` never fires (a real-world scenario: crashed process,
event-loop blockage, environment bug), `pendingSave` never resolves, and `POST /publish`
hangs forever. There is no timeout on the `await pendingSave` call. A senior engineer
would add a timeout or at least document the assumption that saves always complete.

**Point 3 — The fix serialises all publishes behind saves, even unrelated ones.**

In the current single-draft model this is fine. But the fix as written is tight coupling:
every publish anywhere in the app is blocked by the most recent save anywhere in the app.
If the app later adds multiple draft slots (e.g. multiple users, multiple documents), this
one global `pendingSave` would create false serialisation across unrelated operations.
That's a design assumption the fix bakes in silently.

**Point 4 — `pendingSave` is reassigned, not chained.**

If saves arrive in rapid succession — save C before save B has resolved — `pendingSave`
is replaced, not chained. A publish firing at that moment awaits save C but not save B
(which may not have committed yet). In this app that's OK because only the latest save
matters. But a more defensive implementation would chain promises or use a queue.

**Point 5 — No error handling on the save promise.**

The `new Promise` in `/draft` never rejects. If `res.json(...)` throws (unlikely but
possible), the promise hangs rather than rejecting. `/publish` would then wait forever
(see point 2). Best practice is to wrap the setTimeout body in a try/catch and call
`reject(err)` on failure.

**Point 6 — Alternative approach worth noting: pass content to publish.**

A different fix is for the client to send the draft content it wants published directly to
`POST /publish`, skipping the shared `currentDraft` state entirely. This eliminates the
shared-state race at the cost of a slightly different API contract. It's arguably simpler
for a single-user app, though it changes the semantics (you're publishing whatever you
send, not necessarily the last save). The reviewer raised this as a design alternative,
not a defect.

---

## My engagement with each point

### Point 1 — Only the most recent save is tracked
**Category: Context-irrelevant for this assignment.**

The reviewer is correct that the behaviour is implicit. However, the app's stated
semantics are "publish the most recently *saved* draft." Saving "draft C" after "draft B"
means draft B is abandoned — that is the intended user model. The fix correctly reflects
that: the last write wins, and publish serialises behind the last write. The comment in
the code was updated to make this explicit: "tracks the most recent in-flight /draft
request." No code change needed, but I added a sentence to the inline comment to
document the last-write-wins intent.

### Point 2 — Publish can hang if a save never resolves
**Category: Real concern, out of scope.**

This is a valid engineering concern in production. In this assignment the save delay is
a controlled `setTimeout` that always fires; it cannot hang. Adding a `Promise.race`
with a timeout would be the right production-grade fix. For this assignment's scope
(controlled environment, artificial delay) I'm not adding it, but I've noted it in the
comments as a known assumption:

```js
// Assumption: saves always resolve (setTimeout always fires).
// In production, add a timeout guard on pendingSave to avoid indefinite blocking.
await pendingSave;
```

This comment was added to `app/server.js` as a result of this review.

### Point 3 — Global pendingSave couples all publishes to all saves
**Category: Real concern, out of scope.**

Correct. In a multi-user or multi-document system this would be a design flaw. This app
has exactly one draft slot and one user. The coupling is intentional and accurate given
the data model. If the app were extended, `pendingSave` would need to be scoped per-draft
or per-user. Noted in the comment on `pendingSave` but not changed, because the fix is
correct for the system as described.

### Point 4 — Rapid-succession saves are not chained
**Category: Context-irrelevant for this assignment.**

The reviewer is correct that rapid saves mean only the last save's commit is awaited. In
this app's semantics, that is exactly right: the user wants to publish their most recent
draft, not an intermediate one. If saves C and D both arrive, publishing should reflect D.
The current fix does that. Chaining would cause publish to also wait for B, which is
stale and irrelevant. This is not a defect.

### Point 5 — No error handling on the save promise
**Category: Real concern, addressed (partially).**

Added a `try/catch` around the setTimeout body so that errors cause the promise to reject
rather than hang. Added corresponding `.catch` logging in the `/publish` handler so a
rejected pendingSave doesn't swallow silently. This is a legitimate hardening concern even
in this assignment's scope.

```js
pendingSave = new Promise((resolve, reject) => {
  setTimeout(() => {
    try {
      currentDraft = content;
      resolve();
      res.json({ ok: true, saved: content });
    } catch (err) {
      reject(err);
    }
  }, SAVE_COMMIT_DELAY_MS);
});
```

And in `/publish`:
```js
await pendingSave.catch((err) => {
  log('PUBLISH', 'pendingSave rejected — proceeding with current state', { err: err.message });
});
```

### Point 6 — Alternative: pass content to publish
**Category: Style/preference — not taking it.**

This is a valid alternative design. Passing content directly to `/publish` removes shared
state entirely. However, it changes the API contract: the client is now responsible for
tracking what was saved. The existing test (`tests/race.test.js`) tests the current
contract — publish reads from server state, not from client-provided content — so
adopting this alternative would require changing the test, which is out of scope. The
current approach (fix the coordination, keep the API) is appropriate.

---

## What changed in the fix as a result of the review

Two changes were made after review:

1. **Added a `try/catch` in the save promise** (Point 5 — error handling). The save's
   setTimeout body is now wrapped in try/catch, with `reject(err)` on failure. This
   prevents a hanging pendingSave if the response write throws.

2. **Added a `.catch` handler on `await pendingSave` in `/publish`** (Point 5). A
   rejected save no longer silently blocks publish; the error is logged and publish
   proceeds with the current committed state.

3. **Added an inline comment documenting the timeout assumption** (Point 2). A note
   acknowledging that in production, a `Promise.race` with a deadline should guard the
   await.

The fix was re-tested after these changes. Both regression tests still pass (`# pass 2`,
`# fail 0`), and the harness still shows `RESULT: PASS`.
