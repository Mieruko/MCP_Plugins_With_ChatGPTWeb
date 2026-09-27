import { ContentBlockSchema, type ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { toolResult } from "./tool-result.js";

// Bounds are applied to the entire observation; never slice binary data.
export const UPSTREAM_RESULT_LIMITS = {
  wireBytes: 8 * 1024 * 1024,
  textBytes: 128 * 1024,
  blocks: 64,
  images: 4,
} as const;

/** Strip typed binary content from summaries/journals, including nested copies. */
export function withoutBinaryData(value: unknown): any {
  if (Array.isArray(value)) return value.map(withoutBinaryData);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if ((obj.type === "image" || obj.type === "audio") && typeof obj.data === "string") {
    const { data, ...metadata } = obj;
    return { ...withoutBinaryData(metadata), data_omitted: true, encoded_bytes: Buffer.byteLength(data, "utf8") };
  }
  // Embedded binary resources do not have their own type field.
  if (typeof obj.blob === "string" && typeof obj.uri === "string") {
    const { blob, ...metadata } = obj;
    return { ...withoutBinaryData(metadata), data_omitted: true, encoded_bytes: Buffer.byteLength(blob, "utf8") };
  }
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, withoutBinaryData(item)]));
}

function checkSize(value: unknown, maximum: number, label: string): void {
  const json = JSON.stringify(value);
  if (json !== undefined && Buffer.byteLength(json, "utf8") > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
}

function normalize(raw: unknown) {
  checkSize(raw, UPSTREAM_RESULT_LIMITS.wireBytes, "Upstream result");
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  if (obj?.content !== undefined && !Array.isArray(obj.content)) throw new Error("Upstream content must be an array");
  const items = (obj?.content ?? []) as unknown[];
  if (items.length > UPSTREAM_RESULT_LIMITS.blocks) throw new Error("Too many upstream content blocks");
  const content: ContentBlock[] = items.map(item => ContentBlockSchema.parse(item));
  if (content.filter(item => item.type === "image").length > UPSTREAM_RESULT_LIMITS.images) throw new Error("Too many upstream images");
  for (const item of content) {
    const encoded = item.type === "image" || item.type === "audio" ? item.data
      : item.type === "resource" && "blob" in item.resource ? item.resource.blob : undefined;
    if (encoded !== undefined && (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      || Buffer.from(encoded, "base64").toString("base64") !== encoded)) {
      throw new Error("Invalid upstream base64 content");
    }
  }
  const metadata = withoutBinaryData(content);
  const structured = obj?.structuredContent;
  const text = content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const output = withoutBinaryData(structured ?? (obj && "content" in obj ? text : raw));
  checkSize({ output, content: metadata }, UPSTREAM_RESULT_LIMITS.textBytes, "Upstream text/structured result");
  const isError = obj?.isError === true;
  return { content, metadata, output, isError, summary: text.slice(0, 120) || (isError ? "Upstream tool failed" : "Upstream tool completed") };
}

/** Preserve the existing bridge/proxy envelope and forward native content beside it. */
export function upstreamToolResult(tool: string, raw: unknown, identity: Record<string, unknown>, outputKey: "output" | "result" = "output") {
  try {
    const result = normalize(raw);
    const response = toolResult(tool, {
      ...identity,
      [outputKey]: result.output,
      content: result.metadata,
      ...(result.isError ? { error: result.summary } : {}),
    }, { ok: !result.isError, summary: result.summary, content: result.content, isError: result.isError });
    checkSize(response, UPSTREAM_RESULT_LIMITS.wireBytes, "Forwarded result");
    return response;
  } catch (error) {
    // The upstream action already ran. A formatting failure must not encourage a retry.
    const message = error instanceof Error ? error.message.slice(0, 240) : "Invalid upstream result";
    return toolResult(tool, { ...identity, error: "UPSTREAM_RESULT_INVALID", reason: message,
      action_may_have_completed: true, next_step: "Inspect upstream state before retrying; request a smaller observation if needed." },
    { ok: false, isError: true, summary: "Upstream result could not be forwarded; do not repeat the action blindly." });
  }
}
