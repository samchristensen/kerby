import type { MessageChange } from "@earendil-works/pi-durable";

type Block = { type: string; text?: string };

/**
 * Turns Pi's message updates into text appends, never the same text twice. A change may extend a block or
 * restate it whole (a provider that does not stream sends the whole message at once); `seen` counts, per
 * content block, how much text was already passed on. Ported from lochmoore's kerby-worker.
 */
export class TextForwarder {
  readonly #seen = new Map<number, number>();

  reset(): void {
    this.#seen.clear();
  }

  fromBlocks(blocks: readonly Block[]): string[] {
    const out: string[] = [];
    blocks.forEach((block, index) => {
      if (block.type !== "text" || block.text === undefined) return;
      const already = this.#seen.get(index) ?? 0;
      if (block.text.length > already) out.push(block.text.slice(already));
      this.#seen.set(index, Math.max(already, block.text.length));
    });
    return out;
  }

  fromChange(change: MessageChange): string[] {
    switch (change.type) {
      case "text_delta":
        this.#seen.set(
          change.contentIndex,
          (this.#seen.get(change.contentIndex) ?? 0) + change.delta.length,
        );
        return [change.delta];
      case "text_start":
      case "block": {
        const blocks: Block[] = [];
        blocks[change.contentIndex] = change.block;
        return this.fromBlocks(blocks);
      }
      case "message":
        return this.fromBlocks(change.message.content);
      default:
        return [];
    }
  }
}
