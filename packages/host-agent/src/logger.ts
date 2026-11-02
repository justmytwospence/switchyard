import { pino } from "pino";

export type Logger = pino.Logger;

/** Structured logger with credentials redacted. Silent unless `level` (or SWITCHYARD_LOG_LEVEL) says otherwise. */
export function createLogger(
  opts: { level?: string; destination?: pino.DestinationStream } = {},
): Logger {
  const level = opts.level ?? process.env.SWITCHYARD_LOG_LEVEL ?? "info";
  return pino(
    {
      name: "switchyard-host",
      level,
      redact: {
        paths: ["credential", "*.credential", "token", "*.token", "headers.authorization"],
        censor: "[redacted]",
      },
    },
    opts.destination,
  );
}

/** A logger that discards everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
