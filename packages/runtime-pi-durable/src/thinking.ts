import type { MessageChange } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@kerby/agent";

type Block = { type: string; thinking?: string; redacted?: boolean };
type ThinkingEvent = Extract<AgentEvent, { type: "thinking_delta" | "thinking_end" }>;

/**
 * Turns Pi's message updates into the port's reasoning events: `thinking_delta` for each piece of new text (never the
 * same text twice, like `TextForwarder`) and one `thinking_end` per block once it is complete. A block is complete when
 * a later block begins or the message ends, so a block that finished before a crash is still reported.
 */
export class ThinkingForwarder {
  /** Blocks that have begun and not ended: the reasoning passed on so far, and whether the provider redacted it. */
  readonly #open = new Map<number, { text: string; redacted: boolean }>();
  readonly #ended = new Set<number>();

  reset(): void {
    this.#open.clear();
    this.#ended.clear();
  }

  /** Blocks as they stand (a snapshot): reasoning not yet passed on becomes deltas. Nothing ends. */
  fromBlocks(blocks: readonly Block[]): ThinkingEvent[] {
    const out: ThinkingEvent[] = [];
    blocks.forEach((block, index) => {
      this.#syncBlock(index, block, out);
    });
    return out;
  }

  fromChange(change: MessageChange): ThinkingEvent[] {
    const out: ThinkingEvent[] = [];
    if (change.type === "message") {
      change.message.content.forEach((block, index) => {
        this.#syncBlock(index, block, out);
      });
      this.#endBefore(Number.POSITIVE_INFINITY, out);
      return out;
    }
    // Blocks arrive in order: one at a higher index means every thinking block before it is complete.
    this.#endBefore(change.contentIndex, out);
    if (change.type === "thinking_delta") {
      if (!this.#ended.has(change.contentIndex)) {
        this.#state(change.contentIndex).text += change.delta;
        out.push({ type: "thinking_delta", text: change.delta });
      }
    } else if (change.type === "thinking_start" || change.type === "block") {
      this.#syncBlock(change.contentIndex, change.block, out);
    }
    return out;
  }

  /** The message's final content: any reasoning not yet passed on, then the end of every block still open. */
  finish(blocks: readonly Block[]): ThinkingEvent[] {
    const out = this.fromBlocks(blocks);
    this.#endBefore(Number.POSITIVE_INFINITY, out);
    return out;
  }

  #state(index: number): { text: string; redacted: boolean } {
    let state = this.#open.get(index);
    if (!state) {
      state = { text: "", redacted: false };
      this.#open.set(index, state);
    }
    return state;
  }

  #syncBlock(index: number, block: Block, out: ThinkingEvent[]): void {
    if (block.type !== "thinking" || this.#ended.has(index)) return;
    const state = this.#state(index);
    const text = block.thinking ?? "";
    if (text.length > state.text.length) {
      out.push({ type: "thinking_delta", text: text.slice(state.text.length) });
      state.text = text;
    }
    if (block.redacted) state.redacted = true;
  }

  #endBefore(limit: number, out: ThinkingEvent[]): void {
    const indexes = [...this.#open.keys()].filter((index) => index < limit).sort((a, b) => a - b);
    for (const index of indexes) {
      const state = this.#open.get(index);
      this.#open.delete(index);
      this.#ended.add(index);
      if (!state) continue;
      if (state.redacted) out.push({ type: "thinking_end", text: state.text, redacted: true });
      else if (state.text.length > 0) out.push({ type: "thinking_end", text: state.text });
    }
  }
}
