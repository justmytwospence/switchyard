import { httpStatusFor, SwitchyardError } from "@switchyard/protocol";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthedDevice } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    device?: AuthedDevice;
    authVia?: "cookie" | "bearer";
  }
}

/** Parse a request part with a protocol schema; failures become `invalid_request` (400). */
export function parse<S extends z.ZodType>(schema: S, value: unknown, what = "body"): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new SwitchyardError("invalid_request", `Invalid request ${what}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

/** The authenticated device of a request (routes behind the auth hook only). */
export function deviceOf(req: FastifyRequest): AuthedDevice {
  if (!req.device) throw new SwitchyardError("unauthorized", "Not authenticated");
  return req.device;
}

export function sendError(reply: FastifyReply, err: SwitchyardError): FastifyReply {
  return reply.code(httpStatusFor(err.code)).send({ error: err.toBody() });
}

/** Map every thrown error to `{error: {code, message, details?}}`. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | SwitchyardError | Error, req, reply) => {
    if (error instanceof SwitchyardError) {
      if (error.code === "internal") req.log.error({ err: error }, error.message);
      return sendError(reply, error);
    }
    const fe = error as FastifyError;
    if (fe.validation || fe.code === "FST_ERR_CTP_INVALID_JSON_BODY" || fe.statusCode === 400) {
      return sendError(reply, new SwitchyardError("invalid_request", fe.message));
    }
    if (fe.statusCode === 413 || fe.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendError(reply, new SwitchyardError("too_large", fe.message));
    }
    if (fe.statusCode === 415) {
      return sendError(reply, new SwitchyardError("invalid_request", fe.message));
    }
    req.log.error({ err: error }, "unhandled error");
    return sendError(reply, new SwitchyardError("internal", "Internal error"));
  });
}
