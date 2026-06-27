import { test, expect } from "bun:test";
import {
  toChatEvent,
  BusinessAIClient,
  type ChatEvent,
  type ChatHandlers,
  type ChatTransport,
} from "../src/core/businessai.ts";

// --- pure mapping --------------------------------------------------------------

test("token-ish events and the default unnamed event map to tokens", () => {
  expect(toChatEvent({ event: "token", data: "hi" })).toEqual({ kind: "token", text: "hi" });
  expect(toChatEvent({ event: "delta", data: "x" })).toEqual({ kind: "token", text: "x" });
  expect(toChatEvent({ event: "", data: "y" })).toEqual({ kind: "token", text: "y" });
});

test("a JSON data envelope yields its text-ish field", () => {
  expect(toChatEvent({ event: "token", data: '{"text":"abc"}' })).toEqual({ kind: "token", text: "abc" });
  expect(toChatEvent({ event: "", data: '{"delta":"d"}' })).toEqual({ kind: "token", text: "d" });
});

test("done sentinel and named done both terminate", () => {
  expect(toChatEvent({ event: "", data: "[DONE]" })).toEqual({ kind: "done" });
  expect(toChatEvent({ event: "done", data: "" })).toEqual({ kind: "done" });
  expect(toChatEvent({ event: "end", data: "" })).toEqual({ kind: "done" });
});

test("error events map to error", () => {
  expect(toChatEvent({ event: "error", data: "boom" })).toEqual({ kind: "error", message: "boom" });
});

test("UNKNOWN backend control events are opaque meta — the desktop never routes on them", () => {
  for (const ev of ["delegate", "route", "handoff", "brain_hint", "backend_selected"]) {
    expect(toChatEvent({ event: ev, data: "whatever" })).toEqual({ kind: "meta", event: ev, data: "whatever" });
  }
});

// --- client over a fake transport ---------------------------------------------

function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

function clientWith(sse: string, handlers: ChatHandlers) {
  const transport: ChatTransport = { open: async () => streamOf(sse) };
  return new BusinessAIClient(transport, handlers);
}

function record() {
  const log: string[] = [];
  const handlers: ChatHandlers = {
    onConnected: () => log.push("connected"),
    onToken: (t) => log.push(`token:${t}`),
    onMessage: (m) => log.push(`message:${m}`),
    onDone: () => log.push("done"),
    onError: (m) => log.push(`error:${m}`),
    onMeta: (e) => log.push(`meta:${e}`),
    onClosed: () => log.push("closed"),
  };
  return { log, handlers };
}

test("a streamed turn emits tokens, assembles the full message, then done + closed", async () => {
  const { log, handlers } = record();
  const sse = "event: token\ndata: Hello \n\nevent: token\ndata: world\n\nevent: done\ndata: [DONE]\n\n";
  const client = clientWith(sse, handlers);
  client.connect();
  await client.send("hi");
  expect(log).toEqual(["connected", "token:Hello ", "token:world", "message:Hello world", "done", "closed"]);
});

test("opaque control events pass through as meta but never affect token assembly", async () => {
  const { log, handlers } = record();
  const sse =
    "event: delegate\ndata: {\"to\":\"x\"}\n\nevent: token\ndata: ok\n\nevent: done\ndata: [DONE]\n\n";
  const client = clientWith(sse, handlers);
  client.connect();
  await client.send("hi");
  expect(log).toEqual(["connected", "meta:delegate", "token:ok", "message:ok", "done", "closed"]);
});

test("a clean stream end with no done sentinel is still treated as done", async () => {
  const { log, handlers } = record();
  const client = clientWith("event: token\ndata: solo\n\n", handlers);
  client.connect();
  await client.send("hi");
  expect(log).toEqual(["connected", "token:solo", "message:solo", "done", "closed"]);
});

test("an error event surfaces and the turn still closes", async () => {
  const { log, handlers } = record();
  const client = clientWith("event: error\ndata: upstream down\n\n", handlers);
  client.connect();
  await client.send("hi");
  expect(log).toContain("error:upstream down");
  expect(log.at(-1)).toBe("closed");
});

test("send before connect throws", async () => {
  const client = clientWith("", {});
  await expect(client.send("hi")).rejects.toThrow("connect()");
});
