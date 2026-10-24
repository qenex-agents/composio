const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = utf8Bytes(text);
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0b11_000_000) === 0b10_000_000) end -= 1;
  return { text: decoder.decode(buffer.subarray(0, end)), truncated: true };
}
