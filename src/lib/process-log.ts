/** Bounded text log with absolute UTF-16 cursors (independent of chunk boundaries). */
export class ProcessLog {
  private text = "";
  private start = 0;
  constructor(private readonly capacity = 400_000) {}

  append(text: string): void {
    this.text += text;
    if (this.text.length > this.capacity) {
      const drop = this.text.length - this.capacity;
      this.text = this.text.slice(drop);
      this.start += drop;
    }
  }

  get end(): number { return this.start + this.text.length; }

  read(cursor: number | undefined, maxChars: number) {
    const requested = cursor ?? Math.max(this.start, this.end - maxChars);
    if (requested > this.end) throw new Error("Log cursor is ahead of available output");
    const from = Math.max(this.start, requested);
    const text = this.text.slice(from - this.start, from - this.start + maxChars);
    return { text, cursor: from + text.length, dropped: requested < this.start, has_more: from + text.length < this.end };
  }
}
