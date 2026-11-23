import type { ToolCall, ToolResult, ToolSpec } from "@kerby/agent";
import { DEFAULT_JUDGMENT_MODEL, JudgmentRequestSchema } from "@kerby/contracts";
import type { JudgmentOutcome, JudgmentRequest } from "@kerby/judgment";

/**
 * The tools a tenant's conversations may use: an optional built-in `echo` (development), `judge` for a tenant that has
 * stored a judgment key (ADR 0015), and nothing else; the per-tenant registry of remote tools behind the egress guard is
 * plan 0001, M7.
 */
export interface TenantTools {
  specs(): ToolSpec[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

const ECHO: ToolSpec = {
  name: "echo",
  description: "Return the given text unchanged.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  readOnly: true,
};

const JUDGE: ToolSpec = {
  name: "judge",
  description:
    "Ask narrow, typed questions about some text or data and get calibrated probabilities back, not prose. " +
    "Each question is answered independently of the others. A `noul` question returns the probability a statement is " +
    "true (near 0.5 means unsure); a `choice` question returns the most probable of the named options with every " +
    "option's probability; a `score` question returns a position on an ordered scale. Ask one coherent judgment per " +
    "question, give the state only what the questions need, and act on the probabilities, not on the top answer alone.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        description:
          "What the questions refer to: text, or an object. Questions can point into it with backticked paths such as `ticket.messages[0].text`.",
      },
      questions: {
        type: "object",
        description: "Named questions, 1 to 32.",
        additionalProperties: {
          type: "object",
          properties: {
            type: { enum: ["noul", "choice", "score"] },
            instructions: { description: "What to decide, as text or an object." },
            criteria: {
              description:
                "noul: optional {true, false} descriptions of what counts as yes and no. choice: an object mapping each option's name to when it applies. score: an array describing each level in order, from 0.",
            },
          },
          required: ["type", "instructions"],
        },
      },
      model: {
        type: "string",
        description: `Optional model id; defaults to ${DEFAULT_JUDGMENT_MODEL}.`,
      },
    },
    required: ["state", "questions"],
  },
  readOnly: true,
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export type Judge = (
  request: JudgmentRequest,
  signal: AbortSignal,
  /** The tool call's id: what makes the judgment's usage row once-only. */
  callId: string,
) => Promise<JudgmentOutcome>;

export function tenantTools(options: {
  enableEcho: boolean;
  judge: Judge | undefined;
}): TenantTools {
  const { judge } = options;
  return {
    specs: () => [...(options.enableEcho ? [ECHO] : []), ...(judge ? [JUDGE] : [])],
    async execute(call, signal) {
      if (options.enableEcho && call.name === ECHO.name) {
        const input = call.input;
        const text =
          typeof input === "object" &&
          input !== null &&
          "text" in input &&
          typeof input.text === "string"
            ? input.text
            : undefined;
        return text === undefined
          ? textResult("echo needs a string `text`", true)
          : textResult(text);
      }
      if (judge && call.name === JUDGE.name) {
        // The model wrote this input: parse it as the API parses a tenant's, and say what is wrong so it can retry.
        const parsed = JudgmentRequestSchema.safeParse(call.input);
        if (!parsed.success)
          return textResult(
            `judge input is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            true,
          );
        const outcome = await judge(
          { ...parsed.data, model: parsed.data.model ?? DEFAULT_JUDGMENT_MODEL },
          signal,
          call.id,
        );
        return outcome.type === "answered"
          ? textResult(JSON.stringify(outcome.answers))
          : textResult(outcome.error, true);
      }
      return textResult(`unknown tool "${call.name}"`, true);
    },
  };
}
