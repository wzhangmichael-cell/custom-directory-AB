export type SSECallback = (event: { event: string; data: any }) => void;

function parseEventBlock(block: string): { event: string; data: any } | null {
  const lines = block.split("\n");
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!dataLines.length) return null;

  const rawData = dataLines.join("\n");
  try {
    return { event: eventName, data: JSON.parse(rawData) };
  } catch {
    return { event: eventName, data: rawData };
  }
}

export async function connectSSE(
  url: string,
  body: Record<string, unknown>,
  onEvent: SSECallback,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u2028/g, "\n")
      .replace(/\u2029/g, "\n");

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const rawBlock = part.trim();
      if (!rawBlock) continue;

      const parsed = parseEventBlock(rawBlock);
      if (parsed) onEvent(parsed);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const parsed = parseEventBlock(tail);
    if (parsed) onEvent(parsed);
  }
}
