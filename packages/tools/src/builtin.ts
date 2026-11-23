// Kerby's own tools (ADR 0022): served from code by the reserved server `kerby`, so they have no `tools` rows and need
// no enabling, but a grant and a conversation's pattern like any other. A worker runs them; it offers each only when it
// can (`judge` needs the tenant's key for the default judgment provider, `echo` is for development).
import { DEFAULT_JUDGMENT_MODEL, type ToolDefinition, type ToolEffect } from "@kerby/contracts";

type BuiltinTool = { name: string; effect: ToolEffect; definition: ToolDefinition };

const ECHO: BuiltinTool = {
  name: "echo",
  effect: "read",
  definition: {
    description: "Return the given text unchanged.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
};

const JUDGE: BuiltinTool = {
  name: "judge",
  effect: "read",
  definition: {
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
  },
};

/** Every tool of the `kerby` server, by name. */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [ECHO, JUDGE];

export const builtinTool = (name: string): BuiltinTool | undefined =>
  BUILTIN_TOOLS.find((tool) => tool.name === name);
