# Switchyard client SDK

Node.js 24+ ESM client for the Switchyard coordinator. See [the guide](https://github.com/justmytwospence/switchyard/blob/dev/docs/client-sdk.md) for paging, events, and waits.

```sh
npm install @spencerboucher/switchyard-client
```

```js
import { SwitchyardClient } from "@spencerboucher/switchyard-client";

const client = new SwitchyardClient({
  coordinatorUrl: process.env.SWITCHYARD_URL,
  credential: process.env.SWITCHYARD_DEVICE_CREDENTIAL,
});
try {
  const task = await client.tasks.create({ projectId: process.env.PROJECT_ID, title: "Review", objective: "Review the change" });
  console.log(task.id, task.state); // backlog by default
  console.log((await client.tasks.waitForState(task.id, "done")).state);
} finally {
  client.close();
}
```

Use a device bearer credential from the environment, not a hard-coded token. REST calls do not require `connect()`; live waits connect lazily. No automatic mutation retries are performed.
