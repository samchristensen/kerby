// What is indexed (ADR 0021): the text of user and assistant messages, in overlapping pieces small enough to embed and
// to show as a hit. Tool calls, tool results, reasoning and blobs are not text a person searches for.
import type { AgentMessage } from "@kerby/agent";

const MAX_CHARS = 1200;
const OVERLAP_CHARS = 200;

/** The searchable text of a message: its text parts joined by a blank line; undefined when it has none to index. */
export function indexableText(message: AgentMessage): string | undefined {
  if (message.role === "tool") return undefined;
  const texts: string[] = [];
  for (const part of message.content) {
    // Postgres text cannot hold NUL; nobody searches for one.
    if (part.type === "text") texts.push(part.text.replaceAll("\u0000", ""));
  }
  const text = texts.join("\n\n").trim();
  return text === "" ? undefined : text;
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/**
 * Where to end a piece that starts at `start` and may run to `end`: after the last paragraph break, else after the last
 * sentence end, else at the last space, in the window's second half (so no piece is tiny); else at `end` itself.
 */
function cutPoint(text: string, start: number, end: number): number {
  const floor = start + Math.floor((end - start) / 2);
  const paragraph = text.lastIndexOf("\n\n", end - 2);
  if (paragraph >= floor) return paragraph + 2;
  for (let i = end; i > floor; i--) {
    if (!isSpace(text[i])) continue;
    // `.`, `!` or `?`, possibly closed by a quote or bracket, then a space
    let j = i - 1;
    if (j > start && /["')\]]/.test(text[j] ?? "")) j--;
    if (/[.!?]/.test(text[j] ?? "")) return i + 1;
  }
  for (let i = end; i > floor; i--) if (isSpace(text[i])) return i + 1;
  // One unbroken word: cut anywhere, but never between the halves of a surrogate pair.
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Split `text` into pieces of at most `maxChars` (about 1200 by default), each ending at a paragraph, sentence or word
 * boundary where one is near, and starting about `overlapChars` (200) before the previous one ended, at a word, so a
 * phrase cut in two is still whole in one piece. Whitespace-only text has no pieces.
 */
export function chunkText(
  text: string,
  options: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? MAX_CHARS;
  const overlapChars = options.overlapChars ?? OVERLAP_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 2)
    throw new RangeError(`maxChars must be an integer of at least 2, not ${maxChars}`);
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars / 2)
    throw new RangeError(
      `overlapChars must be an integer from 0 to less than half of maxChars (${maxChars}), not ${overlapChars}`,
    );
  const trimmed = text.trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = start + maxChars;
    if (end >= trimmed.length) {
      chunks.push(trimmed.slice(start).trim());
      break;
    }
    const cut = cutPoint(trimmed, start, end);
    const piece = trimmed.slice(start, cut).trim();
    if (piece !== "") chunks.push(piece);
    // The next piece starts `overlapChars` back, moved forward to the start of a word; no overlap if there is none.
    let next = cut - overlapChars;
    if (next > start && !isSpace(trimmed[next - 1])) {
      let space = next;
      while (space < cut && !isSpace(trimmed[space])) space++;
      next = space;
    }
    while (next < cut && isSpace(trimmed[next])) next++;
    start = Math.max(next, start + 1);
  }
  return chunks;
}
