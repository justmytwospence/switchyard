import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One recorded `POST /v1/chat/completions` request, with conveniences for matching. */
export interface MockRequest {
  /** Parsed JSON request body as sent by Pi's openai-completions client. */
  body: any;
  messages: any[];
  /** Role of the last message (`user`, `assistant`, `tool`, `system`). */
  lastRole: string;
  /** Text of the last message (string content or joined text parts). */
  lastText: string;
  /** For a trailing `tool` message: the name of the tool that produced it. */
  lastToolName: string | null;
  /** Names of the tools declared in the request. */
  tools: string[];
}

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
  id?: string;
}

export interface MockReply {
  text?: string;
  thinking?: string;
  toolCalls?: MockToolCall[];
  /** Delay before the first chunk is written. */
  delayMs?: number;
  /** Delay between chunks. */
  chunkDelayMs?: number;
  /** Respond with an HTTP error instead of a stream. */
  error?: { status: number; message: string };
}

export interface MockRule {
  when: (req: MockRequest) => boolean;
  reply: MockReply | ((req: MockRequest) => MockReply);
  /** Use this rule at most once. */
  once?: boolean;
}

/** Ordered rules; the first matching rule answers. Unmatched requests get `"ok"`. */
export type MockScript = MockRule[];

export interface MockModelServer {
  /** Base URL including `/v1`, for `models.json` `baseUrl`. */
  url: string;
  port: number;
  /** Every chat completion request received, in order. */
  requests: MockRequest[];
  /** Replace the script (rules already used with `once` stay used only within the old script). */
  setScript(script: MockScript): void;
  close(): Promise<void>;
}

function messageText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .filter((s: string) => s.length > 0)
      .join("\n");
  }
  return "";
}

function toolNameFor(messages: any[], toolCallId: string | undefined): string | null {
  if (!toolCallId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = messages[i]?.tool_calls;
    if (Array.isArray(calls)) {
      const call = calls.find((c: any) => c?.id === toolCallId);
      if (call) return call.function?.name ?? null;
    }
  }
  return null;
}

export function toMockRequest(body: any): MockRequest {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  const tools: string[] = Array.isArray(body?.tools)
    ? body.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean)
    : [];
  return {
    body,
    messages,
    lastRole: last?.role ?? "",
    lastText: messageText(last),
    lastToolName: last?.role === "tool" ? toolNameFor(messages, last.tool_call_id) : null,
    tools,
  };
}

/** Matcher helpers for scripts. */
export const when = {
  userSays:
    (substr: string) =>
    (req: MockRequest): boolean =>
      req.lastRole === "user" && req.lastText.includes(substr),
  toolResult:
    (toolName?: string) =>
    (req: MockRequest): boolean =>
      req.lastRole === "tool" && (toolName === undefined || req.lastToolName === toolName),
  always: () => (): boolean => true,
};

/** Split text into a few chunks so streaming deltas are exercised. */
function splitText(text: string, parts = 3): string[] {
  if (text.length <= parts) return text.length ? [text] : [];
  const size = Math.ceil(text.length / parts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function streamReply(
  res: ServerResponse,
  req: IncomingMessage,
  reply: MockReply,
  model: string,
): Promise<void> {
  let closed = req.destroyed;
  // IncomingMessage emits `close` once the body is consumed, so watch the response instead.
  res.on("close", () => {
    closed = true;
  });
  if (reply.delayMs) {
    const until = Date.now() + reply.delayMs;
    while (!closed && Date.now() < until) await sleep(Math.min(50, until - Date.now()));
  }
  if (closed) return;
  if (reply.error) {
    res.writeHead(reply.error.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: reply.error.message, type: "mock_error" } }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const send = async (payload: unknown) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
  };
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  await send(chunk({ role: "assistant", content: "" }));
  if (reply.thinking) {
    for (const part of splitText(reply.thinking)) await send(chunk({ reasoning_content: part }));
  }
  if (reply.text) {
    for (const part of splitText(reply.text)) await send(chunk({ content: part }));
  }
  const toolCalls = reply.toolCalls ?? [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index]!;
    const args =
      typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
    const callId = call.id ?? `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await send(
      chunk({
        tool_calls: [
          { index, id: callId, type: "function", function: { name: call.name, arguments: "" } },
        ],
      }),
    );
    for (const part of splitText(args, 2)) {
      await send(chunk({ tool_calls: [{ index, function: { arguments: part } }] }));
    }
  }
  await send(chunk({}, toolCalls.length > 0 ? "tool_calls" : "stop"));
  const completion = Math.max(1, Math.ceil(((reply.text ?? "").length + 3) / 4));
  await send({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: completion, total_tokens: 10 + completion },
  });
  if (!closed) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

/** Start a scripted OpenAI Chat Completions server on 127.0.0.1:0. */
export async function startMockModel(script: MockScript = []): Promise<MockModelServer> {
  let rules = script.map((r) => ({ ...r, used: false }));
  const requests: MockRequest[] = [];

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url}` } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid json" } }));
        return;
      }
      const mreq = toMockRequest(body);
      requests.push(mreq);
      let reply: MockReply = { text: "ok" };
      for (const rule of rules) {
        if (rule.once && rule.used) continue;
        let matched = false;
        try {
          matched = rule.when(mreq);
        } catch {
          matched = false;
        }
        if (matched) {
          rule.used = true;
          reply = typeof rule.reply === "function" ? rule.reply(mreq) : rule.reply;
          break;
        }
      }
      streamReply(res, req, reply, String(body?.model ?? "mock-1")).catch(() => {
        try {
          res.end();
        } catch {
          // ignore
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    setScript(next: MockScript) {
      rules = next.map((r) => ({ ...r, used: false }));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
