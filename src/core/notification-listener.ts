// The notification socket. Owns ONLY connection lifecycle — open an outbound WS, subscribe the
// configured channels, persist each message, reconnect on drop. All frame interpretation is
// delegated to the pure normalizePusherFrame (notifications.ts), so this file has no logic to
// unit-test beyond "wire the callbacks", and the runtime never grows an inbound port (ADR-004).
//
// Reconnect ≠ replay: on a dropped socket we just re-establish and resume LIVE; anything emitted
// while we were down is gone, consistent with "no queue, no replay, no guarantee". The pusher:ping
// → pong exchange below is transport keepalive (the server drops idle sockets), NOT an execution
// liveness/heartbeat boundary — that distinction is the whole point of keeping this listener dumb.

import { abortableSleep } from "./daemon.ts";
import { normalizePusherFrame, pusherUrl, type ListenerConfig, type NotificationEvent } from "./notifications.ts";
import type { Store } from "../storage/db.ts";

export interface ListenerEvents {
  onConnected?: (socketId?: string) => void;
  onDisconnected?: (reason: string) => void;
  /** Called for every app message; `stored` is false when it deduped against an existing event_id. */
  onMessage?: (event: NotificationEvent, stored: boolean) => void;
  onError?: (message: string) => void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Run the listener until `signal` aborts. Persists each received notification (dedup in the store)
 * and surfaces lifecycle via callbacks. Reconnects with capped exponential backoff; a clean
 * session resets the backoff so a flaky link doesn't slowly starve reconnects.
 */
export async function runListener(
  config: ListenerConfig,
  store: Store,
  opts: { signal: AbortSignal } & ListenerEvents,
): Promise<void> {
  let backoff = INITIAL_BACKOFF_MS;
  while (!opts.signal.aborted) {
    try {
      await connectOnce(config, store, opts);
      backoff = INITIAL_BACKOFF_MS; // a session that ran and closed cleanly resets the backoff
    } catch (err) {
      opts.onError?.((err as Error).message);
    }
    if (opts.signal.aborted) break;
    await abortableSleep(backoff, opts.signal);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/** One WebSocket session. Resolves when the socket closes (clean or otherwise) or on abort. */
function connectOnce(
  config: ListenerConfig,
  store: Store,
  opts: { signal: AbortSignal } & ListenerEvents,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const headers = config.authToken ? { Authorization: `Bearer ${config.authToken}` } : undefined;
    // Bun's WebSocket accepts a headers option (beyond the DOM signature) — used for private deployments.
    const ws = new WebSocket(pusherUrl(config), headers ? ({ headers } as unknown as string[]) : undefined);

    const onAbort = () => ws.close(1000, "shutdown");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => opts.signal.removeEventListener("abort", onAbort);

    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = normalizePusherFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
      switch (frame.kind) {
        case "established":
          for (const channel of config.channels) {
            ws.send(JSON.stringify({ event: "pusher:subscribe", data: { channel } }));
          }
          opts.onConnected?.(frame.socketId);
          break;
        case "ping":
          ws.send(JSON.stringify({ event: "pusher:pong" })); // transport keepalive, not liveness
          break;
        case "error":
          opts.onError?.(frame.message);
          break;
        case "message": {
          const stored = store.recordNotification(frame.event);
          opts.onMessage?.(frame.event, stored);
          break;
        }
        case "subscribed":
        case "ignore":
          break;
      }
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      cleanup();
      opts.onDisconnected?.(`closed (code ${ev.code})`);
      resolve();
    });
    ws.addEventListener("error", () => {
      // The browser/Bun WS contract fires `error` then `close`; if a socket errors before opening,
      // no `close` follows, so reject here to release the session. close handler is idempotent-safe.
      cleanup();
      reject(new Error("websocket error"));
    });
  });
}
