import type { ToolCall, ToolResult, ToolSpec } from "@kerby/agent";

/**
 * The tools a tenant's conversations may use. Today: an optional built-in `echo` (development) and nothing else; the
 * per-tenant registry of remote tools behind the egress guard is plan 0001, M7.
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

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function tenantTools(options: { enableEcho: boolean }): TenantTools {
  return {
    specs: () => (options.enableEcho ? [ECHO] : []),
    async execute(call) {
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
      return textResult(`unknown tool "${call.name}"`, true);
    },
  };
}
