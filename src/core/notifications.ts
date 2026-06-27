// Inbound notifications — the desktop's one INBOUND-shaped concern, yet still ADR-004-clean:
// the runtime opens a single OUTBOUND WebSocket and merely *receives* on it (no listen port).
//
// Deliberately minimal (user scope, v0.2): the listener is a pure ear. It is connected,
// disconnected, or receiving a message — nothing more. NO offline queue, NO replay, NO delivery
// guarantee, NO lease/epoch/heartbeat liveness boundary (that whole temporal apparatus belongs
// to the future P3 relay, see the liveness doctrine — emphatically NOT here). Whatever arrives
// while disconnected is simply gone, by design. Dedup is the only correctness property we keep,
// and it lives in the store as UNIQUE(event_id).
//
// This file is PURE: the canonical NotificationEvent and the Pusher/Reverb frame→event
// normalization, with no socket. The socket lives in notification-listener.ts and delegates here,
// so the only logic worth testing is testable without a server.

import { sha256Hex, stableStringify } from "./hash.ts";

/** Pusher protocol version we speak; surfaced in the connection URL's query. */
export const PUSHER_PROTOCOL = "7";
const CLIENT_VERSION = "0.2.0";

/** The canonical, transport-neutral notification — what the store persists and the UI binds to. */
export interface NotificationEvent {
  /** Dedup identity. The source's own id when present, else a content hash of the frame. */
  eventId: string;
  title: string;
  body: string;
  /** Domain bucket ("HQ", "Branch", …); defaults to the channel, then the source event name. */
  type: string;
  receivedAt: number;
}

/** How to reach a Reverb/Pusher endpoint. DOEH-agnostic: host/key/channels are supplied by config. */
export interface ListenerConfig {
  /** Full ws(s):// base override; when set, host/port/scheme/appKey are ignored for the URL. */
  url?: string;
  host: string;
  port?: number;
  scheme?: "ws" | "wss";
  appKey: string;
  channels: string[];
  /** Resolved bearer for the WS handshake (private deployments). Never inline — see ADR-005. */
  authToken?: string;
}

/** A normalized Pusher frame. App messages carry a NotificationEvent; the rest are protocol. */
export type PusherFrame =
  | { kind: "established"; socketId?: string }
  | { kind: "ping" }
  | { kind: "subscribed"; channel?: string }
  | { kind: "error"; message: string }
  | { kind: "message"; event: NotificationEvent }
  | { kind: "ignore" };

/** Build the outbound Pusher/Reverb connection URL (the runtime only ever connects, never listens). */
export function pusherUrl(c: ListenerConfig): string {
  if (c.url) return c.url;
  const scheme = c.scheme ?? "wss";
  const port = c.port ?? (scheme === "wss" ? 443 : 80);
  const q = new URLSearchParams({ protocol: PUSHER_PROTOCOL, client: "invoker", version: CLIENT_VERSION });
  return `${scheme}://${c.host}:${port}/app/${c.appKey}?${q.toString()}`;
}

/** Pusher double-encodes app/control `data` as a JSON string; accept that or a bare object. */
function parseData(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object") return data as Record<string, unknown>;
  if (typeof data === "string") {
    try {
      const v = JSON.parse(data);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Normalize one raw Pusher/Reverb frame into a discriminated event. Pure — `now` is injected so
 * the message branch is deterministic in tests. Unknown/garbage frames collapse to `ignore`.
 */
export function normalizePusherFrame(raw: string, now = Date.now()): PusherFrame {
  let frame: { event?: string; data?: unknown; channel?: string };
  try {
    frame = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  const ev = frame.event;
  if (!ev) return { kind: "ignore" };

  switch (ev) {
    case "pusher:ping":
      return { kind: "ping" };
    case "pusher:pong":
      return { kind: "ignore" };
    case "pusher:connection_established": {
      const d = parseData(frame.data);
      return { kind: "established", socketId: d.socket_id == null ? undefined : String(d.socket_id) };
    }
    case "pusher:error": {
      const d = parseData(frame.data);
      return { kind: "error", message: d.message == null ? raw : String(d.message) };
    }
    case "pusher_internal:subscription_succeeded":
      return { kind: "subscribed", channel: frame.channel };
  }
  // Any other pusher: / pusher_internal: control frame we don't model is noise, not a notification.
  if (ev.startsWith("pusher:") || ev.startsWith("pusher_internal:")) return { kind: "ignore" };

  return { kind: "message", event: toNotificationEvent(frame.channel ?? "", ev, parseData(frame.data), now) };
}

/**
 * Map a source app event to the canonical NotificationEvent. Defensive and DOEH-agnostic: pulls
 * id/title/body/type from conventional fields with fallbacks. When the source carries no id we
 * synthesize a stable content hash so identical re-delivered frames still dedup on UNIQUE(event_id).
 */
export function toNotificationEvent(
  channel: string,
  eventName: string,
  data: Record<string, unknown>,
  now = Date.now(),
): NotificationEvent {
  const explicitId = data.id ?? data.event_id;
  const eventId =
    explicitId != null ? String(explicitId) : sha256Hex(`${channel}|${eventName}|${stableStringify(data)}`);
  return {
    eventId,
    title: String(data.title ?? eventName),
    body: String(data.body ?? data.message ?? ""),
    type: String(data.type ?? channel ?? eventName) || eventName,
    receivedAt: now,
  };
}
