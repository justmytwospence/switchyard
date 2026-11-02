import { newId, Profile, ProfileInput, SwitchyardError } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";

const ProfilePatch = Profile.omit({ id: true }).partial();

/** Seed the "Default" profile (no provider/model overrides) when none exist. */
export function seedDefaultProfile(ctx: Pick<CoordinatorContext, "store">): void {
  ctx.store.tx(() => {
    if (ctx.store.profiles.count() > 0) return;
    ctx.store.putProfile({
      id: newId("prf"),
      name: "Default",
      provider: null,
      model: null,
      thinking: null,
      projectTrust: "ask",
      extraArgs: [],
    });
  });
}

export function registerProfileRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/profiles", async () => ctx.store.profiles.list(undefined, [], "created_at"));

  app.get("/api/profiles/:id", async (req) =>
    ctx.store.profiles.require((req.params as { id: string }).id),
  );

  app.post("/api/profiles", async (req, reply) => {
    const body = parse(ProfileInput, req.body);
    const profile = Profile.parse({ id: newId("prf"), ...body });
    return reply.code(201).send(ctx.store.putProfile(profile));
  });

  app.patch("/api/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(ProfilePatch, req.body);
    return ctx.store.tx(() => {
      const p = ctx.store.profiles.require(id);
      const next = Profile.parse({ ...p, ...stripUndefined(body), id });
      return ctx.store.putProfile(next);
    });
  });

  app.delete("/api/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    return ctx.store.tx(() => {
      ctx.store.profiles.require(id);
      if (ctx.store.profiles.count() <= 1) {
        throw new SwitchyardError("conflict", "At least one profile is required");
      }
      const users = ctx.store.projects.list().filter((p) => p.defaultProfileId === id);
      if (users.length > 0) {
        throw new SwitchyardError("conflict", "Profile is the default of a project", {
          projectIds: users.map((p) => p.id),
        });
      }
      ctx.store.profiles.delete(id);
      return { ok: true, id };
    });
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
