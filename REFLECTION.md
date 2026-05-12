# REFLECTION

## On building the apparatus

### Why do we create a harness? Why is it worth the time, instead of just asking AI to fix the bug directly?

A harness makes the bug reproducible on demand. Without it I could describe the bug in
words, but AI would be guessing at the timing and sequence — it might produce a fix that
looks plausible but doesn't actually eliminate the race, or it might over-engineer a
solution to a problem it never directly observed. The harness gave me a concrete artifact
(trace.txt) I could paste as evidence: "publish fired 60ms after save B, but save B
committed 153ms later — here are the timestamps." That citation changes AI from guesser
to informed collaborator. The time spent building the harness is paid back every time the
fix is wrong and you iterate — you don't have to hope the race fires again, you just run
`node harness/run.js`.

### Why is isolation important?

When the full app is running and a user clicks buttons, the race may or may not fire
depending on network jitter, browser timing, CPU load, and dozens of other variables. You
might click and not trigger it, then conclude the bug isn't happening. The harness drives
only the two endpoints involved — `/draft` and `/publish` — under precise timing control:
save is fired, then publish fires exactly 50ms later, which is well inside the 200ms commit
window. This means every single run triggers the race, not one in ten. Isolation is what
turns "sometimes broken" into "always broken on demand," which is what makes a bug
debuggable.

### How does modular design help in debugging?

The bug had a clean seam: `POST /draft` was one handler and `POST /publish` was a separate
handler, each with a single clear responsibility. I knew immediately which two functions
were involved and could add targeted logging at entry and exit of each without touching
anything else. If the same logic were buried in a 500-line monolithic handler, I would
have had to read hundreds of lines to locate the state variable, every `setTimeout` would
be a suspect, and instrumentation would risk introducing new bugs because touching one
part of a monolith can affect others. Modularity made it possible to say "the problem is
exactly at the boundary between save's commit and publish's read" — and therefore to fix
it in exactly three lines.

---

## On the review

### What kinds of problems with a fix can a code review catch that an automated test cannot?

Tests verify specific, anticipated scenarios. A code review can catch assumptions the test
author never thought to test. For example: "what happens if a save never resolves?" The
regression test always uses a controlled `setTimeout` that fires reliably, so it will
always pass even if the fix has a theoretical hang path. A reviewer looking at the code
asks "under what conditions does `pendingSave` never resolve?" and identifies that
unhandled errors in the timeout callback would leave the promise pending forever. That
category of issue — latent failure modes that exist in the code but are never exercised
by the existing test suite — is the core value of review over testing.

### Quote from your review

From the AI reviewer (Point 5):

> "The `new Promise` in `/draft` never rejects. If `res.json(...)` throws (unlikely but
> possible), the promise hangs rather than rejecting. `/publish` would then wait forever.
> Best practice is to wrap the setTimeout body in a try/catch and call `reject(err)` on
> failure."

Testing alone would not have surfaced this because the test runs in a clean Node
environment where `res.json()` never throws. The test only validates the happy path and
the race path — both of which the fix handles correctly. The reviewer found a third path
(error path) that the test doesn't cover and that the original fix left as a silent hang.
I added `try/catch` in the save promise and a `.catch` handler on `await pendingSave`
as a direct result of this point.
