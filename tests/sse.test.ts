import { test, expect } from "bun:test";
import { parseSseBuffer, consumeSse, type SseEvent } from "../src/core/sse.ts";

test("parses named + default events, multi-line data, comments, and leading space", () => {
  const { events, rest } = parseSseBuffer(
    "event: token\ndata: hello\n\n" + // named
      ": this is a comment\ndata: line1\ndata: line2\n\n" + // default event, multi-line data
      "id: 7\nevent: done\ndata: \n\n",
  );
  expect(rest).toBe("");
  expect(events).toEqual([
    { event: "token", data: "hello" },
    { event: "", data: "line1\nline2" },
    { event: "done", data: "", id: "7" },
  ]);
});

test("an incomplete trailing event is returned as rest, not emitted", () => {
  const { events, rest } = parseSseBuffer("event: token\ndata: a\n\nevent: token\ndata: b");
  expect(events).toEqual([{ event: "token", data: "a" }]);
  expect(rest).toBe("event: token\ndata: b"); // buffered for the next chunk
});

test("normalizes CRLF and handles value with no leading space", () => {
  const { events } = parseSseBuffer("event:token\r\ndata:x\r\n\r\n");
  expect(events).toEqual([{ event: "token", data: "x" }]);
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

test("consumeSse reassembles events split across read-chunk boundaries", async () => {
  // Deliberately cut the wire mid-field, mid-event, and across the blank-line boundary.
  const stream = streamOf(["event: tok", "en\ndata: hel", "lo\n\nevent: done\nda", "ta: [DONE]\n\n"]);
  const got: SseEvent[] = [];
  await consumeSse(stream, (e) => got.push(e));
  expect(got).toEqual([
    { event: "token", data: "hello" },
    { event: "done", data: "[DONE]" },
  ]);
});

test("consumeSse flushes a final event that lacks a trailing blank line", async () => {
  const got: SseEvent[] = [];
  await consumeSse(streamOf(["event: token\ndata: last"]), (e) => got.push(e));
  expect(got).toEqual([{ event: "token", data: "last" }]);
});
