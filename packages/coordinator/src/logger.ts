import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino";

/** Never log credentials, cookies, tokens or push keys. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.credential",
  "*.token",
  "*.keys",
  "*.p256dh",
  "*.auth",
];

export function createLogger(
  opts: { level?: LoggerOptions["level"]; destination?: DestinationStream } = {},
): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? process.env.SWITCHYARD_LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { app: "switchyard-coordinator" },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
