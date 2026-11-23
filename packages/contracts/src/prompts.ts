// Prompts (ADR 0017): named, versioned instructions a tenant keeps in its own database, which its clients use by name
// and version. Two kinds: `chat`, a system prompt in markdown (with `{{variables}}`) plus the model, guardrails and tools
// a conversation runs with; `decision`, the questions (and model) of a judgment (ADR 0015). A prompt has one draft;
// publishing freezes the draft as the next version (1, 2, ...); a label (`production`) points at a version and moves.
import { z } from "zod";
import { GuardrailsSchema, QuestionSetSchema } from "./judgment.ts";
import {
  MAX_PROMPT_TEXT,
  MAX_PROMPT_VARIABLES,
  PromptLabelSchema,
  PromptNameSchema,
  PromptVariableNameSchema,
  PromptVariableValuesSchema,
} from "./prompt-ref.ts";
import { ToolPatternSchema, ToolSelectionSchema } from "./tools.ts";

export const PromptKindSchema = z.enum(["chat", "decision"]);
export type PromptKind = z.infer<typeof PromptKindSchema>;

/** Prompts one tenant may keep, of both kinds: the list is one page. Bytes are bounded by `limits.storageBytes`. */
export const MAX_PROMPTS = 1_000;
/** Versions one prompt may have. */
export const MAX_PROMPT_VERSIONS = 1_000;

/** A value the text refers to as `{{name}}`, filled in by whoever uses the prompt. Without a default it is required. */
const PromptVariableSchema = z.object({
  name: PromptVariableNameSchema,
  description: z.string().max(500).exactOptional(),
  default: z.string().max(MAX_PROMPT_TEXT).exactOptional(),
});
export type PromptVariable = z.infer<typeof PromptVariableSchema>;

const ModelId = z.string().min(1).max(200);

const ChatPromptBodySchema = z.object({
  kind: z.literal("chat"),
  /** Markdown, the conversation's system prompt once its `{{variables}}` are filled in. Empty only in a draft. */
  text: z.string().max(MAX_PROMPT_TEXT),
  /** `<provider>/<model>`; without one, a conversation gets the deployment's default model. */
  model: ModelId.exactOptional(),
  guardrails: GuardrailsSchema.default([]),
  /** The tools a conversation from it may call (ADR 0019); resolved when the conversation is made. */
  tools: ToolSelectionSchema.default([]),
  /** Every `{{name}}` in the text, declared once; a published version declares exactly the names its text uses. */
  variables: z
    .array(PromptVariableSchema)
    .max(MAX_PROMPT_VARIABLES)
    .refine(
      (variables) => new Set(variables.map((v) => v.name)).size === variables.length,
      "variable names must be unique",
    )
    .default([]),
});
export type ChatPromptBody = z.output<typeof ChatPromptBodySchema>;

const DecisionPromptBodySchema = z.object({
  kind: z.literal("decision"),
  /** `<provider>/<model>` of a judgment provider; without one, `DEFAULT_JUDGMENT_MODEL`. */
  model: ModelId.exactOptional(),
  /** The questions a judgment asks of the state it is given. A draft may have none; a published version has 1 or more. */
  questions: QuestionSetSchema,
});
export type DecisionPromptBody = z.output<typeof DecisionPromptBodySchema>;

const PromptBodySchema = z.discriminatedUnion("kind", [
  ChatPromptBodySchema,
  DecisionPromptBodySchema,
]);
export type PromptBody = z.output<typeof PromptBodySchema>;

const Timestamp = z.iso.datetime();
const VersionNumber = z.number().int().min(1);
/** Who did it: `user:<id>` (a person in the console) or `key:<id>` (an API key). */
const Actor = z.string();

export const PromptVersionSummarySchema = z.object({
  version: VersionNumber,
  /** What changed, in the publisher's words. */
  note: z.string().nullable(),
  publishedAt: Timestamp,
  publishedBy: Actor,
});
export type PromptVersionSummary = z.infer<typeof PromptVersionSummarySchema>;

const PromptSummarySchema = z.object({
  name: PromptNameSchema,
  kind: PromptKindSchema,
  /** The highest version; null before the first publish. */
  latestVersion: VersionNumber.nullable(),
  /** Each label and the version it points at. `latest` is implied and not listed. */
  labels: z.record(PromptLabelSchema, VersionNumber),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PromptSummary = z.infer<typeof PromptSummarySchema>;

/** `GET /v1/prompts?kind=<kind>`: every prompt of the tenant (at most `MAX_PROMPTS`), by name. */
export const ListPromptsQuerySchema = z.object({ kind: PromptKindSchema.optional() });
export type ListPromptsQuery = z.infer<typeof ListPromptsQuerySchema>;

export const ListPromptsResponseSchema = z.object({ prompts: z.array(PromptSummarySchema) });
export type ListPromptsResponse = z.infer<typeof ListPromptsResponseSchema>;

/** `GET /v1/prompts/:name`: the prompt, its draft and every version (newest first, without bodies). */
export const PromptSchema = PromptSummarySchema.extend({
  draft: PromptBodySchema,
  /** One more with each save. A save or a publish names the revision it started from; another one is 409 `draft_conflict`. */
  draftRevision: z.number().int().min(0),
  draftUpdatedAt: Timestamp,
  draftUpdatedBy: Actor,
  versions: z.array(PromptVersionSummarySchema),
});
export type Prompt = z.infer<typeof PromptSchema>;

/** `GET /v1/prompts/:name/versions/:version` (`:version` a number or a label): one published version. */
export const PromptVersionSchema = PromptVersionSummarySchema.extend({
  name: PromptNameSchema,
  body: PromptBodySchema,
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

/** `POST /v1/prompts`: a new prompt with an empty draft, or the draft given (of the same kind). */
export const CreatePromptRequestSchema = z
  .object({
    name: PromptNameSchema,
    kind: PromptKindSchema,
    draft: PromptBodySchema.exactOptional(),
  })
  .refine((request) => request.draft === undefined || request.draft.kind === request.kind, {
    message: "draft.kind must be the prompt's kind",
    path: ["draft", "kind"],
  });
export type CreatePromptRequest = z.infer<typeof CreatePromptRequestSchema>;

/** `PUT /v1/prompts/:name/draft`: replace the draft; `revision` is the one the editor started from. */
export const SaveDraftRequestSchema = z.object({
  revision: z.number().int().min(0),
  draft: PromptBodySchema,
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequestSchema>;

/** `POST /v1/prompts/:name/versions`: publish the draft at `revision` as the next version. */
export const PublishPromptRequestSchema = z.object({
  revision: z.number().int().min(0),
  note: z.string().max(1_000).exactOptional(),
});
export type PublishPromptRequest = z.infer<typeof PublishPromptRequestSchema>;

/** `PUT /v1/prompts/:name/labels/:label`: point the label at a version (`latest` cannot be set). */
export const SetPromptLabelRequestSchema = z.object({ version: VersionNumber });

/** `PATCH /v1/prompts/:name`: rename a prompt that has no published version yet (a published name is what clients use). */
export const RenamePromptRequestSchema = z.object({ name: PromptNameSchema });

/** `POST /v1/prompts/:name/versions/:version/render`: a chat prompt's text with its variables filled in. */
export const RenderPromptRequestSchema = z.object({
  variables: PromptVariableValuesSchema.default({}),
});

const RenderedPromptSchema = z.object({
  name: PromptNameSchema,
  version: VersionNumber,
  /** The system prompt: the text with every `{{variable}}` replaced. */
  text: z.string(),
  /** Null: the deployment's default model. */
  model: z.string().nullable(),
  guardrails: GuardrailsSchema,
  tools: z.array(ToolPatternSchema),
});
export type RenderedPrompt = z.infer<typeof RenderedPromptSchema>;
