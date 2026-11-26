# Node client SDK

Install `@spencerboucher/switchyard-client` on Node 24+ (ESM). Browser clients use the browser-specific sync implementation. Supply a device bearer credential via the environment; do not embed it in source or logs:

```ts
import { SwitchyardClient, WaitError } from "@spencerboucher/switchyard-client";
const client = new SwitchyardClient({
  coordinatorUrl: process.env.SWITCHYARD_URL!,
  credential: process.env.SWITCHYARD_DEVICE_CREDENTIAL!,
});
try {
  const session = await client.sessions.create({
    projectId: process.env.PROJECT_ID!,
    workspace: { existingId: process.env.WORKSPACE_ID! },
    prompt: "Inspect the tests",
  });
  await client.sessions.send(session.id, { text: "Summarize the failures" });
  const idle = await client.sessions.waitForFinish(session.id, { timeoutMs: 300_000 });
  console.log(idle.runtime);
  const task = await client.tasks.create({ projectId: process.env.PROJECT_ID!, title: "Fix tests" });
  console.log(task.state); // backlog unless explicitly created in ready
  await client.tasks.waitForState(task.id, ["review", "done"]);
} catch (error) {
  if (error instanceof WaitError) console.error(error.code, error.lastEntity);
  else throw error;
} finally { client.close(); }
```

`waitForFinish` observes **current session quiescence** (idle, steering and follow-up queues empty); it does not identify which prompt completed. `clientMessageId` is echoed, not a completion token or an idempotency guarantee. Waits poll REST during WebSocket outages; abort with `{signal}` or bound them with `{timeoutMs}` (default five minutes). Closing the client terminates waits and subscriptions. REST reads and writes accept `{signal}`; writes are never automatically retried.

## Transcript pages and event cursors

`sessions.transcript(id, {limit, before})` returns **one** page (newest by default, ascending within the page). Page backward using `before` from the oldest item. For incremental updates use `{afterRev, epoch}` from the preceding page. An epoch change yields `reset: true` and a fresh page; replace the cached transcript rather than appending. Transcript revisions and epochs are unrelated to the durable WebSocket sequence.

```ts
const page = await client.sessions.transcript(sessionId, { limit: 100 });
const delta = await client.sessions.transcript(sessionId, { afterRev: page.rev!, epoch: page.epoch! });
if (delta.reset) replaceTranscript(delta.items);
else appendTranscriptChanges(delta.items);
```

Each `events.subscribe` has its own connection. Persist **both** the last successfully handled `seq` and its `projectionId` for across-process resume (atomically, after handling each notice). Do not persist on delivery before processing. A bare cursor intentionally requests a fresh snapshot on new coordinators. Replay can duplicate after a crash; there is no exactly-once delivery guarantee. On `reset`, replace local state with the complete snapshot. Events lost beyond replay retention cannot be reconstructed; stream deltas are not durable notices. Older coordinators may omit capability acknowledgements and still support baseline REST/WS.

```ts
const unsubscribe = client.events.subscribe((notice) => {
  if (notice.type === "reset") replaceState(notice.state);
  else applyEvent(notice.event);
  persistCursor({ seq: notice.type === "reset" ? notice.seq : notice.event.seq,
    projectionId: notice.projectionId });
}, { cursor: saved?.seq, projectionId: saved?.projectionId, onError: console.error });
// unsubscribe() on shutdown; client.close() also closes every subscription.
```

The synced state also carries `issues` (tracked issues) and `terminals` (herdr and tmux sessions, what each mirrors and the sessions it shows); both are empty against older coordinators (a 0.19 coordinator's `surfaces` are read as terminals). Imported historical custom messages retain portable text but do not rerun adapter hooks. The SDK does not fetch an entire transcript automatically or retry failed writes.
