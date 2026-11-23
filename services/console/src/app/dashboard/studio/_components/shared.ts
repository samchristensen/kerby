// Pure helpers the Studio's editors and forms share (server-safe, no hooks).
import type { ChatPromptBody, PromptSummary } from "@kerby/contracts";

/** A JSON value, as instructions and criteria hold. */
export type Json = ChatPromptBody["guardrails"][number]["instructions"];

export const inputClass =
  "block w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-fg shadow-sm placeholder:text-muted/60 focus:outline-2 focus:outline-offset-0 focus:outline-brand";

export const labelClass = "block text-sm font-medium text-fg";

/** Every way to ask for a published version: the labels (`latest` first) and then each number, newest first. */
export function versionChoices(
  prompt: Pick<PromptSummary, "latestVersion" | "labels">,
): { value: string; label: string }[] {
  if (prompt.latestVersion === null) return [];
  const choices = [{ value: "latest", label: `latest (v${prompt.latestVersion})` }];
  for (const [label, version] of Object.entries(prompt.labels)) {
    choices.push({ value: label, label: `${label} (v${version})` });
  }
  for (let version = prompt.latestVersion; version >= 1; version -= 1) {
    choices.push({ value: String(version), label: `v${version}` });
  }
  return choices;
}

/**
 * Instructions and criteria are JSON in a judgment; the editor shows a string as text and anything else as JSON, and
 * saves each back the way it came.
 */
export type JsonText = { text: string; json: boolean };

export const toJsonText = (value: unknown): JsonText =>
  value === undefined || typeof value === "string"
    ? { text: value ?? "", json: false }
    : { text: JSON.stringify(value, null, 2), json: true };

/** The value a `JsonText` stands for; throws a message naming `where` when its JSON does not parse. */
export function fromJsonText(value: JsonText, where: string): Json {
  if (!value.json) return value.text;
  try {
    return JSON.parse(value.text);
  } catch {
    throw new Error(`${where} is not valid JSON.`);
  }
}

/** A key for a row the person adds or removes, so React keeps each row's own inputs. */
let rowKey = 0;
export const newRowKey = (): number => {
  rowKey += 1;
  return rowKey;
};
