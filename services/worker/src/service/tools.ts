import type { ToolCall, ToolResult, ToolSpec } from "@kerby/agent";
import { DEFAULT_JUDGMENT_MODEL, JudgmentRequestSchema } from "@kerby/contracts";
import type { JudgmentOutcome, JudgmentRequest } from "@kerby/judgment";
import { builtinTool } from "@kerby/tools";

/**
 * The tools a tenant's conversations may use: an optional built-in `echo` (development), `judge` for a tenant that has
 * stored a judgment key (ADR 0015), and nothing else; the per-tenant registry of remote tools behind the egress guard is
 * plan 0001, M7.
 */
export interface TenantTools {
  specs(): ToolSpec[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

/** A built-in tool as the harness takes it. */
function builtinSpec(name: string): ToolSpec {
  const tool = builtinTool(name);
  if (!tool) throw new Error(`@kerby/tools has no built-in tool "${name}"`);
  return {
    name: tool.name,
    description: tool.definition.description,
    inputSchema: tool.definition.inputSchema,
    readOnly: tool.effect === "read",
  };
}

const ECHO = builtinSpec("echo");
const JUDGE = builtinSpec("judge");

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
