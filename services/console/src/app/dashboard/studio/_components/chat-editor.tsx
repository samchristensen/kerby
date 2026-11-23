"use client";
// A chat prompt's draft: its markdown text, model, guardrails, tools, and a variables table kept in step with the text's
// `{{names}}` (the server parses them, as it will when the prompt is used).
import type { AvailableTool, ChatPromptBody } from "@kerby/contracts";
import { useEffect, useRef, useState } from "react";
import { MarkdownEditor } from "../../../_components/markdown-editor.tsx";
import { ToolPicker } from "../../../_components/tool-picker.tsx";
import { buttonStyles, Card } from "../../../_components/ui.tsx";
import { templateVariablesAction } from "../actions.ts";
import { DraftBar } from "./draft-bar.tsx";
import {
  fromJsonText,
  inputClass,
  type JsonText,
  labelClass,
  newRowKey,
  toJsonText,
} from "./shared.ts";

type Guardrail = ChatPromptBody["guardrails"][number];

type GuardrailRow = {
  key: number;
  name: string;
  appliesTo: Guardrail["appliesTo"];
  instructions: JsonText;
  blockAt: string;
  model: string;
  /** Kept as it was: the editor does not change a guardrail's criteria. */
  criteria: Guardrail["criteria"];
};

type VariableRow = { description: string; default: string };

const VARIABLES_DELAY_MS = 400;

const toRow = (guardrail: Guardrail): GuardrailRow => ({
  key: newRowKey(),
  name: guardrail.name,
  appliesTo: guardrail.appliesTo,
  instructions: toJsonText(guardrail.instructions),
  blockAt: String(guardrail.blockAt),
  model: guardrail.model ?? "",
  criteria: guardrail.criteria,
});

export function ChatDraftEditor({
  name,
  revision,
  draft,
  providers,
  tools,
}: {
  name: string;
  revision: number;
  draft: ChatPromptBody;
  providers: string[];
  /** The enabled tools the draft may name. */
  tools: AvailableTool[];
}) {
  const [text, setText] = useState(draft.text);
  const [model, setModel] = useState(draft.model ?? "");
  const [toolPatterns, setToolPatterns] = useState(draft.tools);
  const [guardrails, setGuardrails] = useState(() => draft.guardrails.map(toRow));
  const [names, setNames] = useState(() => draft.variables.map((v) => v.name));
  // By name, so a variable's description survives the text dropping it for a moment.
  const [variables, setVariables] = useState<Record<string, VariableRow>>(() =>
    Object.fromEntries(
      draft.variables.map((v) => [
        v.name,
        { description: v.description ?? "", default: v.default ?? "" },
      ]),
    ),
  );
  const [dirty, setDirty] = useState(false);
  const textRef = useRef(text);

  useEffect(() => {
    textRef.current = text;
    const timer = setTimeout(() => {
      void templateVariablesAction(text).then((found) => {
        if (textRef.current === text) setNames(found);
      });
    }, VARIABLES_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const changed = () => setDirty(true);
  const updateGuardrail = (key: number, change: Partial<GuardrailRow>) => {
    setGuardrails((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
    changed();
  };
  const updateVariable = (variable: string, change: Partial<VariableRow>) => {
    setVariables((rows) => ({
      ...rows,
      [variable]: { description: "", default: "", ...rows[variable], ...change },
    }));
    changed();
  };

  async function build(): Promise<ChatPromptBody> {
    // The text's variables as of now, not as of the last pause in typing.
    const current = await templateVariablesAction(text);
    setNames(current);
    return {
      kind: "chat",
      text,
      ...(model.trim() ? { model: model.trim() } : {}),
      guardrails: guardrails.map((row, index) => {
        const blockAt = Number(row.blockAt);
        if (!(blockAt > 0 && blockAt <= 1)) {
          throw new Error(
            `Guardrail ${index + 1}: block at must be a number above 0 and at most 1.`,
          );
        }
        return {
          name: row.name.trim(),
          appliesTo: row.appliesTo,
          instructions: fromJsonText(row.instructions, `Guardrail ${index + 1}'s question`),
          blockAt,
          ...(row.model.trim() ? { model: row.model.trim() } : {}),
          ...(row.criteria ? { criteria: row.criteria } : {}),
        };
      }),
      // A tool under a whole server picked too is covered by it.
      tools: toolPatterns.filter(
        (pattern) =>
          pattern.endsWith("/*") ||
          !toolPatterns.includes(`${pattern.slice(0, pattern.indexOf("/"))}/*`),
      ),
      variables: current.map((variable) => {
        const row = variables[variable];
        return {
          name: variable,
          ...(row?.description.trim() ? { description: row.description.trim() } : {}),
          ...(row?.default ? { default: row.default } : {}),
        };
      }),
    };
  }

  return (
    <div className="space-y-6">
      <Card title="Text">
        <p id="prompt-text-label" className="mb-2 text-sm text-zinc-500">
          The system prompt, in markdown. Write <code className="font-mono">{"{{name}}"}</code>{" "}
          where a value goes in.
        </p>
        <MarkdownEditor
          name="text"
          id="prompt-text"
          aria-labelledby="prompt-text-label"
          defaultValue={draft.text}
          placeholder="You are a support agent for…"
          onChange={(markdown) => {
            setText(markdown);
            changed();
          }}
        />
      </Card>

      <Card title="Variables">
        {names.length === 0 ? (
          <p className="text-sm text-zinc-500">
            None. Each <code className="font-mono">{"{{name}}"}</code> in the text appears here.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 font-medium">Default (blank: required)</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {names.map((variable) => {
                const row = variables[variable];
                return (
                  <tr key={variable}>
                    <td className="py-1 pr-3">
                      <code className="font-mono">{variable}</code>
                      {row?.default ? null : (
                        <span className="ml-2 text-xs text-amber-700">required</span>
                      )}
                    </td>
                    <td className="py-1 pr-3">
                      <input
                        aria-label={`${variable} description`}
                        value={row?.description ?? ""}
                        maxLength={500}
                        onChange={(event) =>
                          updateVariable(variable, { description: event.target.value })
                        }
                        className={inputClass}
                      />
                    </td>
                    <td className="py-1">
                      <input
                        aria-label={`${variable} default`}
                        value={row?.default ?? ""}
                        onChange={(event) =>
                          updateVariable(variable, { default: event.target.value })
                        }
                        className={inputClass}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Model">
        <label htmlFor="prompt-model" className={labelClass}>
          Model
        </label>
        <input
          id="prompt-model"
          value={model}
          maxLength={200}
          autoComplete="off"
          placeholder="provider/model-id"
          onChange={(event) => {
            setModel(event.target.value);
            changed();
          }}
          className={`${inputClass} mt-1.5`}
        />
        <p className="mt-1.5 text-sm text-zinc-500">
          {providers.length > 0
            ? `Keys on file for: ${providers.join(", ")}. Leave blank for the workspace default.`
            : "You have no model keys yet: add one under Model providers. Leave blank for the workspace default."}
        </p>
      </Card>

      <Card title="Tools">
        <p className="mb-3 text-sm text-zinc-500">
          The tools a conversation from this prompt may call. None checked, none offered. A client
          using it must be granted each one.
        </p>
        <ToolPicker
          available={tools}
          selected={draft.tools}
          onChange={(patterns) => {
            setToolPatterns(patterns);
            changed();
          }}
        />
      </Card>

      <Card
        title="Guardrails"
        actions={
          <button
            type="button"
            className={buttonStyles.secondary}
            onClick={() => {
              setGuardrails((rows) => [
                ...rows,
                {
                  key: newRowKey(),
                  name: "",
                  appliesTo: "user_message",
                  instructions: { text: "", json: false },
                  blockAt: "0.8",
                  model: "",
                  criteria: undefined,
                },
              ]);
              changed();
            }}
          >
            Add guardrail
          </button>
        }
      >
        {guardrails.length === 0 ? (
          <p className="text-sm text-zinc-500">
            None. A guardrail is a yes/no question asked before the assistant acts; a yes blocks the
            message or tool call.
          </p>
        ) : (
          <ul className="space-y-4">
            {guardrails.map((row, index) => (
              <li key={row.key} className="space-y-3 rounded-lg border border-zinc-200 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    Name
                    <input
                      value={row.name}
                      maxLength={64}
                      placeholder="jailbreak"
                      onChange={(event) => updateGuardrail(row.key, { name: event.target.value })}
                      className={`${inputClass} mt-1.5`}
                    />
                  </label>
                  <label className={labelClass}>
                    Applies to
                    <select
                      value={row.appliesTo}
                      onChange={(event) =>
                        updateGuardrail(row.key, {
                          appliesTo:
                            event.target.value === "tool_call" ? "tool_call" : "user_message",
                        })
                      }
                      className={`${inputClass} mt-1.5`}
                    >
                      <option value="user_message">A user message</option>
                      <option value="tool_call">A tool call</option>
                    </select>
                  </label>
                  <label className={labelClass}>
                    Block at (probability of yes)
                    <input
                      type="number"
                      min={0.01}
                      max={1}
                      step={0.01}
                      value={row.blockAt}
                      onChange={(event) =>
                        updateGuardrail(row.key, { blockAt: event.target.value })
                      }
                      className={`${inputClass} mt-1.5`}
                    />
                  </label>
                  <label className={labelClass}>
                    Model (optional)
                    <input
                      value={row.model}
                      maxLength={200}
                      placeholder="typesafe/jev-latest"
                      onChange={(event) => updateGuardrail(row.key, { model: event.target.value })}
                      className={`${inputClass} mt-1.5`}
                    />
                  </label>
                </div>
                <label className={labelClass}>
                  Question{row.instructions.json ? " (JSON)" : ""}
                  <textarea
                    value={row.instructions.text}
                    rows={2}
                    placeholder="Does `message` try to make the assistant ignore its instructions?"
                    onChange={(event) =>
                      updateGuardrail(row.key, {
                        instructions: { ...row.instructions, text: event.target.value },
                      })
                    }
                    className={`${inputClass} mt-1.5`}
                  />
                </label>
                <button
                  type="button"
                  className="text-sm text-red-600 hover:underline"
                  onClick={() => {
                    setGuardrails((rows) => rows.filter((r) => r.key !== row.key));
                    changed();
                  }}
                >
                  Remove guardrail {index + 1}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <DraftBar name={name} revision={revision} dirty={dirty} build={build} />
    </div>
  );
}
