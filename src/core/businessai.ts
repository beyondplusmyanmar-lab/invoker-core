// The desktop's BusinessAI chat consumer. STRICTLY a consumer (ADR-009): it connects, sends a
// turn, and renders the streamed reply. It is NOT a proxy, router, planner, delegate, or fallback
// engine. The desktop never observes BusinessAI's reasoning/orchestration — if the backend emits
// control events (delegate / route / handoff / brain_hint / backend_selected), the desktop treats
// them as OPAQUE metadata and acts on none of them. "Business AI streams thoughts; invoker executes
// intents" — here invoker isn't even executing, just displaying the thought stream.
//
// The event surface the desktop understands is fixed and small: connected, token, message, done,
// error, closed (+ opaque meta). Tokens are mapped from the SSE wire; lifecycle (connected/closed)
// is owned by the client, not the backend.

import { consumeSse, type SseEvent } from "./sse.ts";

/** A mapped chat event. Anything the desktop doesn't model collapses to `meta` (opaque, inert). */
export type ChatEvent =
  | { kind: "token"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "meta"; event: string; data: string };

const DONE_SENTINEL = "[DONE]";

/**
 * Map one SSE event to a ChatEvent. Deliberately small and defensive:
 *   - `token`/`delta`/`chunk`, and the default unnamed data event → streamed token text
 *   - `done`/`end`/`complete`, or the OpenAI-style `[DONE]` sentinel on any event → done
 *   - `error` → error
 *   - EVERYTHING ELSE → opaque meta. The desktop is a consumer, not a router: it never branches on
 *     delegate/route/handoff/brain_hint/backend_selected — it just records them as metadata.
 */
export function toChatEvent(sse: SseEvent): ChatEvent {
  if (sse.data.trim() === DONE_SENTINEL) return { kind: "done" };
  switch (sse.event) {
    case "":
    case "message":
    case "token":
    case "delta":
    case "chunk":
      return { kind: "token", text: extractText(sse.data) };
    case "done":
    case "end":
    case "complete":
      return { kind: "done" };
    case "error":
      return { kind: "error", message: extractText(sse.data) || "stream error" };
    default:
      return { kind: "meta", event: sse.event, data: sse.data };
  }
}

/** Pull display text from an SSE data payload — raw string, or a JSON envelope's text-ish field. */
function extractText(data: string): string {
  const trimmed = data.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return data;
  try {
    const v = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["text", "token", "delta", "content", "message"]) {
      if (typeof v[key] === "string") return v[key] as string;
    }
    return data;
  } catch {
    return data;
  }
}

export interface BusinessAIConfig {
  /** BusinessAI chat endpoint (returns text/event-stream). */
  url: string;
  /** Resolved bearer; never inline (ADR-005). */
  authToken?: string;
}

/** Opens a streaming turn. Injectable so the client is testable without a network. */
export interface ChatTransport {
  open(message: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export interface ChatHandlers {
  onConnected?: () => void;
  onToken?: (text: string) => void;
  /** The full assembled reply, fired alongside done (the "message" surface). */
  onMessage?: (fullText: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  /** Opaque backend control events. Surfaced, never acted upon. */
  onMeta?: (event: string, data: string) => void;
  onClosed?: () => void;
}

/** The default transport: a POST whose response body is the SSE stream. */
export class FetchChatTransport implements ChatTransport {
  constructor(private readonly config: BusinessAIConfig) {}

  async open(message: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : {}),
      },
      body: JSON.stringify({ message }),
      signal,
    });
    if (!res.ok) throw new Error(`businessai responded ${res.status}`);
    if (!res.body) throw new Error("businessai response had no body");
    return res.body;
  }
}

/**
 * Thin chat client over a ChatTransport. One turn at a time: `send` streams tokens, assembles them,
 * and closes. Holds no conversation routing or backend selection — those are the brain's job.
 */
export class BusinessAIClient {
  private controller?: AbortController;
  private connected = false;

  constructor(
    private readonly transport: ChatTransport,
    private readonly handlers: ChatHandlers = {},
  ) {}

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.handlers.onConnected?.();
  }

  /** Send one turn and stream the reply. Resolves when the turn's stream closes. */
  async send(message: string): Promise<void> {
    if (!this.connected) throw new Error("call connect() before send()");
    const controller = new AbortController();
    this.controller = controller;
    let assembled = "";
    let sawDone = false;
    try {
      const stream = await this.transport.open(message, controller.signal);
      await consumeSse(
        stream,
        (sse) => {
          const ev = toChatEvent(sse);
          switch (ev.kind) {
            case "token":
              assembled += ev.text;
              this.handlers.onToken?.(ev.text);
              break;
            case "done":
              sawDone = true;
              this.handlers.onMessage?.(assembled);
              this.handlers.onDone?.();
              break;
            case "error":
              this.handlers.onError?.(ev.message);
              break;
            case "meta":
              this.handlers.onMeta?.(ev.event, ev.data); // opaque
              break;
          }
        },
        controller.signal,
      );
      // Some backends close the stream without an explicit done sentinel; treat a clean end as done.
      if (!sawDone && !controller.signal.aborted) {
        this.handlers.onMessage?.(assembled);
        this.handlers.onDone?.();
      }
    } catch (err) {
      if (!controller.signal.aborted) this.handlers.onError?.((err as Error).message);
    } finally {
      this.handlers.onClosed?.();
      this.controller = undefined;
    }
  }

  /** Abort any in-flight turn and mark disconnected. */
  disconnect(): void {
    this.controller?.abort();
    this.connected = false;
  }
}
