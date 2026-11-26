import { expect, test, uid } from "./support";

test.describe("settings clients", () => {
  test(
    "lists herdr and tmux sessions apart from devices",
    { tag: "@smoke" },
    async ({ page, signIn, api, state }, info) => {
      await signIn();
      const tag = uid(info)
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
      const deviceName = `cli-${tag}`;
      const enrollment = await api<{ token: string }>("POST", "/api/devices/enrollments");
      const enrolled = (await (
        await fetch(`${state.baseURL}/api/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: enrollment.token, name: deviceName, kind: "cli" }),
        })
      ).json()) as { deviceId: string; credential: string };

      const herdrId = `herdr:run${tag}@box`;
      const tmuxId = `tmux:gone${tag}@box`;
      const reported = await fetch(`${state.baseURL}/api/clients/${encodeURIComponent(herdrId)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${enrolled.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "herdr", name: `run${tag}`, machine: "box" }),
      });
      expect(reported.ok).toBe(true);
      // Bound before its plugin ever reported: never seen.
      await api("PUT", `/api/clients/${encodeURIComponent(tmuxId)}/binding`, { mirror: "none" });
      const scope = await api<{ id: string }>("POST", "/api/scopes", {
        name: `mirror-${tag}`.slice(0, 50),
        mode: "pinned",
      });

      try {
        await page.goto("/settings/clients");
        const list = page.getByTestId("client-list");
        const running = list.getByTestId("client-row").filter({ hasText: `herdr run${tag}` });
        await expect(running).toContainText("Running");
        await expect(running).toContainText(`signed in with ${deviceName}`);
        await expect(running.getByRole("button", { name: "Forget" })).toHaveCount(0);
        // Long text wraps beside the controls, not one letter per line.
        const box = (await running.getByTestId("client-name").boundingBox())!;
        expect(box.height).toBeLessThan(60);

        await running.getByLabel(`What herdr run${tag} mirrors`).selectOption(`scope:${scope.id}`);
        await expect
          .poll(async () => {
            const all = await api<{ id: string; mirror: string; scopeId: string | null }[]>(
              "GET",
              "/api/clients",
            );
            const c = all.find((x) => x.id === herdrId);
            return `${c?.mirror}:${c?.scopeId}`;
          })
          .toBe(`scope:${scope.id}`);

        const gone = list.getByTestId("client-row").filter({ hasText: `tmux gone${tag}` });
        await expect(gone).toContainText("Not running");
        await expect(gone).toContainText("never seen");
        await gone.getByRole("button", { name: "Forget" }).click();
        await page.getByRole("button", { name: "Forget client" }).click();
        await expect(gone).toHaveCount(0);
        const left = await api<{ id: string }[]>("GET", "/api/clients");
        expect(left.some((c) => c.id === tmuxId)).toBe(false);

        const devices = page.getByTestId("device-list");
        const cli = devices.getByTestId("device-row").filter({ hasText: deviceName });
        await expect(cli).toContainText("1 herdr or tmux session");
        await expect(
          cli.getByRole("button", { name: "Set as preferred mobile device" }),
        ).toHaveCount(0);
        const browser = devices.getByTestId("device-row").filter({ hasText: "This device" });
        await expect(
          browser.getByRole("button", { name: "Set as preferred mobile device" }),
        ).toBeVisible();
      } finally {
        await api("DELETE", `/api/clients/${encodeURIComponent(herdrId)}`).catch(() => {});
        await api("DELETE", `/api/clients/${encodeURIComponent(tmuxId)}`).catch(() => {});
        await api("DELETE", `/api/scopes/${scope.id}`).catch(() => {});
        await api("DELETE", `/api/devices/${enrolled.deviceId}`).catch(() => {});
      }
    },
  );
});
