// How a client names a prompt (ADR 0017): by name and a version or label. Kept apart from prompts.ts so the
// conversations and judgments contracts can refer to a prompt without importing the prompt bodies, which import them.
import { z } from "zod";

const NAME_SEGMENT = "[a-z0-9][a-z0-9-]{0,62}";

/**
 * A prompt's name: up to 5 segments of lowercase letters, digits and `-`, joined by `/` (folders in the studio), at
 * most 200 characters: `support/triage`. Unique in the tenant across both kinds. In a URL path the name is one segment,
 * so its `/` is sent as `%2F`.
 */
export const PromptNameSchema = z
  .string()
  .max(200)
  .regex(
    new RegExp(`^${NAME_SEGMENT}(?:/${NAME_SEGMENT}){0,4}$`),
    "a prompt name is up to 5 segments of lowercase letters, digits and -, joined by /",
  );

/** The label every prompt answers to without setting it: its highest version. It cannot be set or removed. */
export const LATEST_LABEL = "latest";

/** A label (`production`, `staging`): a lowercase letter, then lowercase letters, digits or `-`, up to 32. */
export const PromptLabelSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,31}$/,
    "a label is a lowercase letter, then lowercase letters, digits or -, up to 32",
  );

const VersionNumberSchema = z.number().int().min(1).max(999_999_999);

/** A version: its number, from 1, or a label that points at one (`production`, `latest`). */
const PromptVersionSelectorSchema = z.union([VersionNumberSchema, PromptLabelSchema]);
export type PromptVersionSelector = z.infer<typeof PromptVersionSelectorSchema>;

/** `:version` in a URL path: digits are a version number, anything else a label. */
export const PromptVersionParamSchema = z
  .string()
  .max(32)
  .transform((text) => (/^\d+$/.test(text) ? Number(text) : text))
  .pipe(PromptVersionSelectorSchema);

/** Variables a chat prompt may declare. */
export const MAX_PROMPT_VARIABLES = 32;

/** The characters of a chat prompt's text, and of its rendered result: the same as a conversation's system prompt. */
export const MAX_PROMPT_TEXT = 100_000;

/** A variable's name, as `{{name}}` refers to it: a letter or `_`, then letters, digits or `_`, up to 64. */
export const PromptVariableNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
    "a variable name is a letter or _, then letters, digits or _, up to 64",
  )
  .refine((name) => name !== "__proto__", "must not be __proto__");

/** Values for a chat prompt's `{{variables}}`, by name. A variable without a default must have one. */
export const PromptVariableValuesSchema = z
  .record(PromptVariableNameSchema, z.string().max(MAX_PROMPT_TEXT))
  .refine(
    (values) => Object.keys(values).length <= MAX_PROMPT_VARIABLES,
    `at most ${MAX_PROMPT_VARIABLES} variables`,
  );
export type PromptVariableValues = z.infer<typeof PromptVariableValuesSchema>;

/** A published prompt to use: its name and a version number or label. */
export const PromptRefSchema = z.object({
  name: PromptNameSchema,
  version: PromptVersionSelectorSchema,
});
export type PromptRef = z.infer<typeof PromptRefSchema>;

/** A chat prompt to start a conversation from, with values for its variables. */
export const ChatPromptRefSchema = PromptRefSchema.extend({
  variables: PromptVariableValuesSchema.exactOptional(),
});
export type ChatPromptRef = z.infer<typeof ChatPromptRefSchema>;

/**
 * The version a conversation or judgment was made from: a label is resolved once, when it is made, so moving the label
 * later never changes what an existing conversation runs with.
 */
export const PinnedPromptSchema = z.object({
  name: PromptNameSchema,
  version: VersionNumberSchema,
});
export type PinnedPrompt = z.infer<typeof PinnedPromptSchema>;
