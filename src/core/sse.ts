// A pure Server-Sent Events wire parser, plus a thin reader over a byte stream. No knowledge of
// chat, BusinessAI, or tokens lives here — that mapping is businessai.ts. Kept generic and pure so
// the only fiddly logic (event framing across chunk boundaries) is testable without a network.

/** One decoded SSE event. `event` is "" when the source omitted the field (spec default is dispatched
 *  as "message"; we preserve the distinction so the chat layer can tell unnamed token streams apart). */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Split accumulated SSE text into complete events, returning any trailing partial as `rest` to be
 * prepended to the next chunk. Pure: feed it the running buffer, store the `rest`, repeat.
 * Handles CRLF/CR, multi-line `data:` (joined with \n), `:` comment lines, and value-leading-space.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const text = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: SseEvent[] = [];
  let idx = 0;
  let boundary: number;
  while ((boundary = text.indexOf("\n\n", idx)) !== -1) {
    const ev = parseBlock(text.slice(idx, boundary));
    if (ev) events.push(ev);
    idx = boundary + 2;
  }
  return { events, rest: text.slice(idx) };
}

function parseBlock(block: string): SseEvent | null {
  let event = "";
  let id: string | undefined;
  const data: string[] = [];
  let sawField = false;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        sawField = true;
        break;
      case "data":
        data.push(value);
        sawField = true;
        break;
      case "id":
        id = value;
        sawField = true;
        break;
      // `retry:` is ignored — v0.2 does not honor server-driven reconnect hints.
    }
  }
  return sawField ? { event, data: data.join("\n"), id } : null;
}

/**
 * Read an SSE byte stream to completion, dispatching each event through `onEvent`. Reassembles
 * events that span read-chunk boundaries via parseSseBuffer's `rest`. Stops on stream end or abort;
 * a final unterminated event (no trailing blank line) is flushed so a clean close loses nothing.
 */
export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buf);
      buf = rest;
      for (const e of events) onEvent(e);
    }
    buf += decoder.decode();
    if (buf.trim() && !signal?.aborted) {
      for (const e of parseSseBuffer(`${buf}\n\n`).events) onEvent(e);
    }
  } finally {
    reader.releaseLock();
  }
}
