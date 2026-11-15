import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionAdaptersResult } from "@switchyard/protocol";
import { type MockScript, when } from "@switchyard/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  compatSkipReason,
  effectiveResourcesSupported,
  expectLegacyDiscovery,
  PLUGINS_DIR,
  pluginPackages,
  recordResult,
  resourceSnapshot,
  startCompatHarness,
} from "./helpers.js";

const skip = compatSkipReason();
const script: MockScript = [
  {
    when: when.userSays("create a todo"),
    reply: {
      toolCalls: [
        { name: "todo", arguments: { action: "create", subject: "Isolated development" } },
      ],
    },
  },
  { when: when.toolResult("todo"), reply: { text: "Created." } },
];

describe.skipIf(skip !== null)(`plugin development compat${skip ? ` (${skip})` : ""}`, () => {
  for (const terminalSessions of [false, true]) {
    it(`read-only inspection is independent of delivery support (${terminalSessions ? "terminal" : "rpc"})`, async () => {
      const h = await startCompatHarness({ plugins: [], script: [], terminalSessions });
      try {
        const s = await h.startSession();
        const live = h.agent.supervisor.managedSession(s.id)!;
        const snapshot = await resourceSnapshot(h, s);
        await effectiveResourcesSupported(h, s);
        recordResult(`resources-${terminalSessions ? "terminal" : "rpc"}`, {
          snapshot,
          hello: live.bridgeFeatures,
          adapters: h.agent.supervisor.sessionAdapters(s.id),
        });
        expect(snapshot).toMatchObject({
          cwd: h.pi.cwd,
          pendingDialogs: 0,
          runtimeId: live.bridgeFeatures!.runtimeId,
        });
        expect(snapshot.reportedExtensionPaths.every((path) => typeof path === "string")).toBe(
          true,
        );
        // An absent draft capability must never masquerade as a safe empty editor.
        if (!live.bridgeFeatures!.capabilities.editorDraftGuard)
          expect(snapshot.hasEditorDraft).toBe(true);
        expect(h.mock.requests).toEqual([]);
      } finally {
        await h.dispose();
      }
    });
  }
  it("reloads an isolated edited entry, fences old actions and removes disabled adapters", async () => {
    const h = await startCompatHarness({ plugins: ["pi-todo"], script, writableSuite: true });
    try {
      expect(h.suiteDir).not.toBe(PLUGINS_DIR);
      const s = await h.startSession();
      const first = await h.coord.ok<SessionAdaptersResult>({
        type: "session.adapters",
        sessionId: s.id,
      });
      expect(first.generation).toEqual(expect.any(String));
      if (!(await effectiveResourcesSupported(h, s))) {
        expectLegacyDiscovery(first);
        const reloaded = await h.coord.ok<{ generation: string }>({
          type: "session.reloadAdapters",
          sessionId: s.id,
        });
        expect(reloaded.generation).not.toBe(first.generation);
        expectLegacyDiscovery(h.agent.supervisor.sessionAdapters(s.id));
        expect(h.mock.requests).toEqual([]);
        return;
      }
      expect(first.adapters.find((a) => a.id === "todo")).toMatchObject({
        tier: "plugin",
        runtimeStatus: "active",
      });
      const adapterFile = join(h.suiteDir, "packages/pi-todo/src/switchyard/adapter.ts");
      const original = readFileSync(adapterFile, "utf8");
      const sharedOriginal = readFileSync(
        join(PLUGINS_DIR, "packages/pi-todo/src/switchyard/adapter.ts"),
        "utf8",
      );
      expect(original).toContain("export default {");
      // The fixture replaces presentation restoration only, never the plugin workflow.
      writeFileSync(
        adapterFile,
        original
          .replace(
            "export default {",
            `export default {
        onRestore(ctx) { ctx.setPanel("development-proof", { t: "text", text: "Edited entry" }, { title: "Edited", mobileFallback: "Edited entry" }); },`,
          )
          .replace(/onRestore: renderTodo,/, ""),
      );
      const reloaded = await h.coord.ok<{ generation: string }>({
        type: "session.reloadAdapters",
        sessionId: s.id,
      });
      expect(reloaded.generation).not.toBe(first.generation);
      expect(s.panels()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            adapterId: "todo",
            slot: "development-proof",
            node: { t: "text", text: "Edited entry" },
          }),
        ]),
      );
      expect(
        readFileSync(join(PLUGINS_DIR, "packages/pi-todo/src/switchyard/adapter.ts"), "utf8"),
      ).toBe(sharedOriginal);
      const stale = await h.coord.command({
        type: "session.adapterAction",
        sessionId: s.id,
        generation: first.generation!,
        adapterId: "todo",
        actionId: "never-dispatch",
        payload: null,
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
      const other = await h.startSession();
      expect(
        other
          .panels()
          .some((p) => p.node && JSON.stringify(p.node).includes("Isolated development")),
      ).toBe(false);
      const settingsFile = join(h.pi.agentDir, "settings.json");
      const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      writeFileSync(settingsFile, JSON.stringify({ ...settings, packages: [] }));
      await h.coord.ok({ type: "session.reloadAdapters", sessionId: s.id });
      const removed = await h.coord.ok<SessionAdaptersResult>({
        type: "session.adapters",
        sessionId: s.id,
      });
      expect(removed.adapters.some((a) => a.id === "todo" && a.runtimeStatus === "active")).toBe(
        false,
      );
      expect(s.panels().filter((p) => p.adapterId === "todo")).toEqual([]);
      expect(h.mock.requests).toEqual([]);
      expect(s.uiResponses).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  for (const projectTrust of ["approve", "ignore"] as const) {
    it(`respects project-local packages and trust (${projectTrust})`, async () => {
      const h = await startCompatHarness({
        plugins: ["pi-todo"],
        script,
        userPackages: [{ source: PLUGINS_DIR, autoload: false }],
        projectPackages: pluginPackages(["pi-todo"]),
        projectTrust,
      });
      try {
        const s = await h.startSession();
        const result = await h.coord.ok<SessionAdaptersResult>({
          type: "session.adapters",
          sessionId: s.id,
        });
        if (!(await effectiveResourcesSupported(h, s))) {
          expectLegacyDiscovery(result);
          expect((await resourceSnapshot(h, s)).projectTrusted).toBeNull();
          expect(s.panels().filter((p) => p.adapterId === "todo")).toEqual([]);
          expect(h.mock.requests).toEqual([]);
          return;
        }
        const snapshot = await resourceSnapshot(h, s);
        recordResult(`resources-project-${projectTrust}`, { snapshot, adapters: result });
        const { projectTrusted } = snapshot;
        if (projectTrusted === true) {
          expect(projectTrust).toBe("approve");
          const todo = result.adapters.find((a) => a.id === "todo");
          expect(todo).toMatchObject({ runtimeStatus: "active", provenance: { scope: "project" } });
          const before = s.settledCount();
          await s.prompt("create a todo");
          await s.waitSettled(before);
          expect(s.toolEnds("todo").at(-1)?.isError).toBe(false);
          expect(
            s
              .panels()
              .some(
                (p) =>
                  p.adapterId === "todo" &&
                  p.node &&
                  JSON.stringify(p.node).includes("Isolated development"),
              ),
          ).toBe(true);
        } else {
          // Old Pi cannot attest project trust. This explicitly tests unsupported capability:
          // no project adapter imports and visible diagnostics, not a skipped success claim.
          expect(
            result.adapters.filter(
              (a) => a.provenance.scope === "project" && a.runtimeStatus === "active",
            ),
          ).toEqual([]);
          expect(s.panels().filter((p) => p.adapterId === "todo")).toEqual([]);
          if (projectTrusted === null) {
            expect(result.diagnostics.some((d) => /trust|resource|legacy/i.test(d.message))).toBe(
              true,
            );
          } else {
            expect(projectTrust).toBe("ignore");
          }
        }
      } finally {
        await h.dispose();
      }
    });
  }
});
