import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import {
  normalizePusherFrame,
  toNotificationEvent,
  pusherUrl,
  type NotificationEvent,
} from "../src/core/notifications.ts";

function withStore<T>(fn: (store: Store) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "invoker-notify-"));
  const store = new Store(dir);
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const event = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  eventId: "evt-1",
  title: "Inventory policy changed",
  body: "HQ updated the policy",
  type: "HQ",
  receivedAt: Date.now(),
  ...over,
});

// --- store: dedup + read state -------------------------------------------------

test("recording the same event_id twice dedups (the only correctness property)", () => {
  withStore((store) => {
    expect(store.recordNotification(event())).toBe(true); // inserted
    expect(store.recordNotification(event())).toBe(false); // deduped on UNIQUE(event_id)
    expect(store.listNotifications()).toHaveLength(1);
  });
});

test("unread count and mark-read transitions", () => {
  withStore((store) => {
    store.recordNotification(event({ eventId: "a", title: "A" }));
    store.recordNotification(event({ eventId: "b", title: "B" }));
    expect(store.unreadNotificationCount()).toBe(2);

    const first = store.listNotifications()[0]!;
    expect(store.markNotificationRead(first.id)).toBe(true);
    expect(store.unreadNotificationCount()).toBe(1);
    expect(store.markNotificationRead(first.id)).toBe(false); // already read → no-op
    expect(store.markNotificationRead("ghost")).toBe(false); // unknown id
  });
});

test("mark-all-read returns the number affected and clears unread", () => {
  withStore((store) => {
    store.recordNotification(event({ eventId: "a" }));
    store.recordNotification(event({ eventId: "b" }));
    store.recordNotification(event({ eventId: "c" }));
    expect(store.markAllNotificationsRead()).toBe(3);
    expect(store.unreadNotificationCount()).toBe(0);
    expect(store.markAllNotificationsRead()).toBe(0); // nothing left
  });
});

test("listNotifications is newest-first and --unread filters", () => {
  withStore((store) => {
    store.recordNotification(event({ eventId: "old", receivedAt: 1000 }));
    store.recordNotification(event({ eventId: "new", receivedAt: 2000 }));
    const all = store.listNotifications();
    expect(all.map((n) => n.eventId)).toEqual(["new", "old"]);

    store.markNotificationRead(all.find((n) => n.eventId === "new")!.id);
    const unread = store.listNotifications({ unreadOnly: true });
    expect(unread.map((n) => n.eventId)).toEqual(["old"]);
  });
});

// --- pure frame normalization --------------------------------------------------

test("control frames normalize to their kind", () => {
  expect(normalizePusherFrame(JSON.stringify({ event: "pusher:ping" })).kind).toBe("ping");
  expect(normalizePusherFrame("not json").kind).toBe("ignore");
  expect(normalizePusherFrame(JSON.stringify({ event: "pusher:pong" })).kind).toBe("ignore");

  const est = normalizePusherFrame(
    JSON.stringify({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: "123.456" }) }),
  );
  expect(est).toEqual({ kind: "established", socketId: "123.456" });

  const sub = normalizePusherFrame(
    JSON.stringify({ event: "pusher_internal:subscription_succeeded", channel: "hq" }),
  );
  expect(sub).toEqual({ kind: "subscribed", channel: "hq" });
});

test("an app message normalizes to a NotificationEvent (data is double-encoded)", () => {
  const frame = normalizePusherFrame(
    JSON.stringify({
      event: "NotificationCreated",
      channel: "hq",
      data: JSON.stringify({ id: "n-7", title: "Promotion", body: "Starts tomorrow", type: "Branch" }),
    }),
    1234,
  );
  expect(frame.kind).toBe("message");
  if (frame.kind !== "message") throw new Error("unreachable");
  expect(frame.event).toEqual({
    eventId: "n-7",
    title: "Promotion",
    body: "Starts tomorrow",
    type: "Branch",
    receivedAt: 1234,
  });
});

test("an event with no source id gets a STABLE content-hash id so re-delivery still dedups", () => {
  const data = { title: "Target uploaded", body: "Monthly target" };
  const a = toNotificationEvent("hq", "TargetUploaded", data, 1);
  const b = toNotificationEvent("hq", "TargetUploaded", data, 999); // different time, same content
  expect(a.eventId).toMatch(/^[0-9a-f]{64}$/);
  expect(a.eventId).toBe(b.eventId); // identical frames → identical dedup key
  expect(a.type).toBe("hq"); // falls back to channel when no explicit type
});

test("pusherUrl builds an outbound ws URL from parts or honors a full override", () => {
  const url = pusherUrl({ host: "reverb.example", appKey: "appkey", channels: [], scheme: "wss" });
  expect(url).toBe("wss://reverb.example:443/app/appkey?protocol=7&client=invoker&version=0.2.0");
  expect(
    pusherUrl({ url: "ws://localhost:8080/app/x", host: "ignored", appKey: "ignored", channels: [] }),
  ).toBe("ws://localhost:8080/app/x");
});
