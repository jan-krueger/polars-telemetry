import { Gunzip } from "fflate";

export const isGzip = (bytes: Uint8Array): boolean => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Every member of a gzip file: an events file is written as one member per batch, which gunzipSync stops after. */
export function gunzipText(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  let text = "";
  new Gunzip((chunk, final) => {
    text += decoder.decode(chunk, { stream: !final });
  }).push(bytes, true);
  return text;
}

/** A file's text, decompressed when it is gzip. */
export async function fileText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return isGzip(bytes) ? gunzipText(bytes) : new TextDecoder().decode(bytes);
}
