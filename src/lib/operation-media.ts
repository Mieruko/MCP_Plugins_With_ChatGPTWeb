import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { withoutBinaryData } from "./upstream-result.js";

export interface OperationMedia {
  count: number;
  captured_at: string;
  expires_at: string;
  storage: "memory_only";
}

/** Short-lived observations, never part of the persistent operation journal. */
export class OperationMediaCache {
  private entries = new Map<string, { blocks: ContentBlock[]; bytes: number; expires: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now, private readonly maxEntries = 128) {}

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  private prune() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.remove(key);
  }

  store(taskId: string, operationId: string, result: unknown): { result: unknown; media?: OperationMedia } {
    this.prune();
    const key = `${taskId}:${operationId}`;
    this.remove(key);
    const obj = result as { content?: ContentBlock[] } | undefined;
    const blocks = Array.isArray(obj?.content) ? obj.content.filter(block => block.type === "image" || block.type === "audio"
      || (block.type === "resource" && "blob" in block.resource)) : [];
    if (!blocks.length) return { result };
    const captured = this.now(), expires = captured + this.ttlMs;
    const bytes = Buffer.byteLength(JSON.stringify(blocks), "utf8");
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
        this.remove(this.entries.keys().next().value!);
      }
      this.entries.set(key, { blocks: structuredClone(blocks), bytes, expires });
      this.bytes += bytes;
    }
    return { result: withoutBinaryData(result), media: { count: blocks.length, storage: "memory_only",
      captured_at: new Date(captured).toISOString(), expires_at: new Date(expires).toISOString() } };
  }

  // Caller must first enforce operation task binding and current scope.
  read(taskId: string, operationId: string): ContentBlock[] {
    this.prune();
    return structuredClone(this.entries.get(`${taskId}:${operationId}`)?.blocks ?? []);
  }
}

export const operationMediaCache = new OperationMediaCache();
