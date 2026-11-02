import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { SwitchyardClient } from "../src/client.js";
import { applySnapshot, applyTranscriptPage } from "../src/store.js";
import { interaction, item, session, syncState } from "./fixtures.js";

function clientWith(state: Parameters<typeof applySnapshot>[2]) {
  const client = new SwitchyardClient({
    coordinatorUrl: "http://coord",
    credential: "c",
    fetch: async () => new Response(JSON.stringify({ items: [], hasMore: false })),
  });
  client.store.update((s) => applySnapshot(s, 1, state));
  return client;
}

describe("App (rendered to a string)", () => {
  it("lists sessions grouped by project", () => {
    const client = clientWith(syncState());
    client.store.update((s) => ({ ...s, connection: { ...s.connection, state: "live" } }));
    const out = renderToString(createElement(App, { client, onExit: () => undefined }), {
      columns: 100,
    });
    expect(out).toContain("Switchyard sessions");
    expect(out).toContain("alpha");
    expect(out).toContain("> Fix login");
    expect(out).toContain("Idle");
  });

  it("shows the transcript, a pending question and the status line in the session view", () => {
    const client = clientWith(
      syncState({
        sessions: [session({ runtime: "waiting_input" })],
        interactions: [
          interaction({
            t: "form",
            formId: "f",
            submitLabel: "Submit",
            fields: [
              {
                kind: "select",
                name: "q1",
                label: "Fruit",
                options: [
                  { value: "a", label: "Apple" },
                  { value: "p", label: "Pear" },
                ],
              },
            ],
          }),
        ],
      }),
    );
    client.store.update((s) =>
      applyTranscriptPage(
        s,
        "ses_1",
        [item({ id: "itm_u", kind: "user", data: { text: "hello there" } })],
        false,
      ),
    );
    const out = renderToString(
      createElement(App, { client, initialSessionId: "ses_1", onExit: () => undefined }),
      { columns: 100 },
    );
    expect(out).toContain("you: hello there");
    expect(out).toContain("Needs your answer: Pick one");
    expect(out).toContain("( ) Apple");
    expect(out).toContain("Needs input | control: manual | host: mac (online)");
    expect(out).toContain("Enter queue follow-up | Ctrl+S steer");
  });
});
