import { describe, expect, it } from "vitest";
import { chunkText, indexableText } from "./index.ts";

describe("indexableText", () => {
  it("joins user and assistant text parts and skips everything else", () => {
    expect(
      indexableText({
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "blob", blobId: "b", mediaType: "image/png" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\n\nsecond");
    expect(
      indexableText({
        role: "assistant",
        content: [
          { type: "tool_call", id: "c", name: "shell", input: { cmd: "ls" } },
          { type: "text", text: "done" },
        ],
        model: "m",
        stopReason: "end",
      }),
    ).toBe("done");
  });

  it("has nothing for a tool result, a message without text, or blank text", () => {
    expect(
      indexableText({
        role: "tool",
        toolCallId: "c",
        content: [{ type: "text", text: "output" }],
        isError: false,
      }),
    ).toBeUndefined();
    expect(
      indexableText({
        role: "assistant",
        content: [{ type: "tool_call", id: "c", name: "shell", input: {} }],
        model: "m",
        stopReason: "tool_use",
      }),
    ).toBeUndefined();
    expect(
      indexableText({ role: "user", content: [{ type: "text", text: " \n " }] }),
    ).toBeUndefined();
  });
});

describe("chunkText", () => {
  it("keeps short text whole and has no chunk for whitespace", () => {
    expect(chunkText("  hello there  ")).toEqual(["hello there"]);
    expect(chunkText(" \n\t ")).toEqual([]);
    expect(chunkText("")).toEqual([]);
  });

  it("cuts at a paragraph before a sentence, and at a sentence before a word", () => {
    const paragraphs = `${"a ".repeat(40).trim()}. More words here.\n\n${"b ".repeat(40).trim()}`;
    expect(chunkText(paragraphs, { maxChars: 120, overlapChars: 0 })[0]).toBe(
      `${"a ".repeat(40).trim()}. More words here.`,
    );
    const sentences = `${"word ".repeat(15).trim()}. ${"next ".repeat(15).trim()}`;
    expect(chunkText(sentences, { maxChars: 100, overlapChars: 0 })[0]).toBe(
      `${"word ".repeat(15).trim()}.`,
    );
    const words = "alpha beta gamma delta epsilon zeta eta theta";
    const chunks = chunkText(words, { maxChars: 20, overlapChars: 0 });
    for (const chunk of chunks)
      expect(words.split(" ")).toEqual(expect.arrayContaining(chunk.split(" ")));
    expect(chunks.join(" ")).toBe(words);
  });

  it("stays within the limit, overlaps at word starts, and covers the whole text", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1200);
      expect(chunk.length).toBeGreaterThan(400);
      expect(chunk.startsWith("w")).toBe(true); // a whole word, never the tail of one
    }
    for (const [i, chunk] of chunks.slice(1).entries()) {
      const previous = chunks[i] ?? "";
      const firstWord = chunk.split(" ")[0] ?? "";
      // the next chunk starts with a word from about 200 characters before the previous one ended
      expect(previous.split(" ")).toContain(firstWord);
      const overlap = previous.length - previous.indexOf(` ${firstWord} `);
      expect(overlap).toBeGreaterThan(150);
      expect(overlap).toBeLessThan(260);
    }
    const words = new Set(chunks.flatMap((chunk) => chunk.split(" ")));
    expect(words.size).toBe(2000);
  });

  it("cuts a word longer than the limit without splitting a surrogate pair", () => {
    const chunks = chunkText("😀".repeat(30), { maxChars: 11, overlapChars: 0 });
    expect(chunks.join("")).toBe("😀".repeat(30));
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(11);
    for (const chunk of chunks) expect(chunk).toMatch(/^(😀)+$/u);
  });

  it("refuses limits that cannot make progress", () => {
    expect(() => chunkText("x", { maxChars: 1 })).toThrow(/maxChars/);
    expect(() => chunkText("x", { maxChars: 100, overlapChars: 60 })).toThrow(/overlapChars/);
  });
});
