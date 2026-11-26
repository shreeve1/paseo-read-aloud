import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };

const TARGET_CHARS = 250;

function jsonBytes(value: string) {
  let bytes = 0;
  for (const char of JSON.stringify(value)) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function centralChunks(cleaned: string, voiceId: string): string[] {
  const text = cleaned.replace(/[\uD800-\uDBFF]$/u, ""); // text cleanup may truncate at the reply limit.
  const chars = Array.from(text);
  const overhead = '{"voice_id":,"text":""}'.length + jsonBytes(voiceId);
  const budget = protocol.limits.max_request_bytes - overhead;
  // The remaining bytes belong to the JSON string content after the object, keys, separators and quotes.
  const chunks: string[] = [];
  for (let start = 0; start < chars.length;) {
    while (start < chars.length && /\s/u.test(chars[start])) start++;
    if (start === chars.length) break;
    let end = start;
    let breakAt = start;
    let bytes = 0;
    while (end < chars.length && end - start < TARGET_CHARS) {
      const char = chars[end];
      bytes += jsonBytes(char) - 2;
      if (bytes > budget) break;
      if (/\s/u.test(char)) breakAt = end;
      end++;
    }
    if (end === start) throw new Error("The Central voice ID is too long. Choose another voice or use Local voice.");
    if (end < chars.length && !/\s/u.test(chars[end]) && breakAt - start >= (end - start) * 0.4) end = breakAt;
    chunks.push(chars.slice(start, end).join("").trimEnd());
    start = end;
  }
  return chunks;
}
