"use client";
// A decision model's draft: the questions a judgment asks of a state (noul: a yes/no probability; choice: one of named
// options; score: one of ordered levels) and the judgment model.
import type { DecisionPromptBody } from "@kerby/contracts";
import { useState } from "react";
import { buttonStyles, Card } from "../../../_components/ui.tsx";
import { DraftBar } from "./draft-bar.tsx";
import {
  fromJsonText,
  inputClass,
  type Json,
  type JsonText,
  labelClass,
  newRowKey,
  toJsonText,
} from "./shared.ts";

type Question = DecisionPromptBody["questions"][string];
type QuestionType = Question["type"];

type OptionRow = { key: number; name: string; description: JsonText };
type LevelRow = { key: number; description: JsonText };

/** Every type's criteria are kept, so switching a question's type and back loses nothing. */
type QuestionRow = {
  key: number;
  name: string;
  type: QuestionType;
  instructions: JsonText;
  yes: JsonText;
  no: JsonText;
  options: OptionRow[];
  levels: LevelRow[];
};

const EMPTY: JsonText = { text: "", json: false };

const TYPES: { type: QuestionType; label: string }[] = [
  { type: "noul", label: "Yes or no (noul)" },
  { type: "choice", label: "Choice" },
  { type: "score", label: "Score" },
];

function toRow(name: string, question: Question): QuestionRow {
  return {
    key: newRowKey(),
    name,
    type: question.type,
    instructions: toJsonText(question.instructions),
    yes: toJsonText(question.type === "noul" ? question.criteria?.true : undefined),
    no: toJsonText(question.type === "noul" ? question.criteria?.false : undefined),
    options:
      question.type === "choice"
        ? Object.entries(question.criteria).map(([option, description]) => ({
            key: newRowKey(),
            name: option,
            description: toJsonText(description),
          }))
        : [],
    levels:
      question.type === "score"
        ? question.criteria.map((description) => ({
            key: newRowKey(),
            description: toJsonText(description),
          }))
        : [],
  };
}

function toQuestion(row: QuestionRow, where: string): Question {
  const instructions = fromJsonText(row.instructions, `${where}'s instructions`);
  if (row.type === "noul") {
    const criteria: { true?: Json; false?: Json } = {};
    if (row.yes.text) criteria.true = fromJsonText(row.yes, `${where}'s yes description`);
    if (row.no.text) criteria.false = fromJsonText(row.no, `${where}'s no description`);
    return {
      type: "noul",
      instructions,
      ...(criteria.true !== undefined || criteria.false !== undefined ? { criteria } : {}),
    };
  }
  if (row.type === "choice") {
    const criteria: Record<string, Json> = {};
    for (const option of row.options) {
      const optionName = option.name.trim();
      if (!optionName) throw new Error(`${where}: give every option a name.`);
      if (Object.hasOwn(criteria, optionName)) {
        throw new Error(`${where}: option "${optionName}" appears twice.`);
      }
      criteria[optionName] = fromJsonText(option.description, `${where}'s option ${optionName}`);
    }
    return { type: "choice", instructions, criteria };
  }
  return {
    type: "score",
    instructions,
    criteria: row.levels.map((level, index) =>
      fromJsonText(level.description, `${where}'s level ${index}`),
    ),
  };
}

function JsonTextArea({
  label,
  value,
  onChange,
  rows = 2,
  placeholder,
}: {
  label: string;
  value: JsonText;
  onChange: (value: JsonText) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className={labelClass}>
      {label}
      {value.json ? " (JSON)" : ""}
      <textarea
        value={value.text}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange({ ...value, text: event.target.value })}
        className={`${inputClass} mt-1.5 font-normal`}
      />
    </label>
  );
}

const removeClass = "text-sm text-danger hover:underline";

export function DecisionDraftEditor({
  name,
  revision,
  draft,
  providers,
}: {
  name: string;
  revision: number;
  draft: DecisionPromptBody;
  providers: string[];
}) {
  const [model, setModel] = useState(draft.model ?? "");
  const [questions, setQuestions] = useState(() =>
    Object.entries(draft.questions).map(([question, body]) => toRow(question, body)),
  );
  const [dirty, setDirty] = useState(false);

  const update = (key: number, change: (row: QuestionRow) => Partial<QuestionRow>) => {
    setQuestions((rows) => rows.map((row) => (row.key === key ? { ...row, ...change(row) } : row)));
    setDirty(true);
  };

  async function build(): Promise<DecisionPromptBody> {
    const built: Record<string, Question> = {};
    questions.forEach((row, index) => {
      const questionName = row.name.trim();
      const where = `Question ${index + 1}`;
      if (!questionName)
        throw new Error(`${where}: give it a name; your code reads its answer by it.`);
      if (Object.hasOwn(built, questionName)) {
        throw new Error(`${where}: the name "${questionName}" is already used.`);
      }
      built[questionName] = toQuestion(row, where);
    });
    return { kind: "decision", ...(model.trim() ? { model: model.trim() } : {}), questions: built };
  }

  return (
    <div className="space-y-6">
      <Card title="Model">
        <label htmlFor="decision-model" className={labelClass}>
          Model
        </label>
        <input
          id="decision-model"
          value={model}
          maxLength={200}
          autoComplete="off"
          placeholder="typesafe/jev-latest"
          onChange={(event) => {
            setModel(event.target.value);
            setDirty(true);
          }}
          className={`${inputClass} mt-1.5`}
        />
        <p className="mt-1.5 text-sm text-muted">
          {providers.length > 0
            ? `Keys on file for: ${providers.join(", ")}. Leave blank for the default judgment model.`
            : "You have no judgment provider keys yet: add one under Model providers. Leave blank for the default judgment model."}
        </p>
      </Card>

      <Card
        title="Questions"
        actions={
          <button
            type="button"
            className={buttonStyles.secondary}
            onClick={() => {
              setQuestions((rows) => [
                ...rows,
                {
                  key: newRowKey(),
                  name: "",
                  type: "noul",
                  instructions: EMPTY,
                  yes: EMPTY,
                  no: EMPTY,
                  options: [],
                  levels: [],
                },
              ]);
              setDirty(true);
            }}
          >
            Add question
          </button>
        }
      >
        {questions.length === 0 ? (
          <p className="text-sm text-muted">
            No questions yet. A published decision model asks at least one.
          </p>
        ) : (
          <ul className="space-y-4">
            {questions.map((row, index) => (
              <li key={row.key} className="space-y-3 rounded-lg border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    Name
                    <input
                      value={row.name}
                      maxLength={100}
                      placeholder="urgent"
                      onChange={(event) => update(row.key, () => ({ name: event.target.value }))}
                      className={`${inputClass} mt-1.5`}
                    />
                  </label>
                  <label className={labelClass}>
                    Type
                    <select
                      value={row.type}
                      onChange={(event) =>
                        update(row.key, () => ({
                          type: TYPES.find((t) => t.type === event.target.value)?.type ?? "noul",
                        }))
                      }
                      className={`${inputClass} mt-1.5`}
                    >
                      {TYPES.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <JsonTextArea
                  label="Instructions"
                  value={row.instructions}
                  rows={3}
                  placeholder="Is the customer asking for something that cannot wait?"
                  onChange={(instructions) => update(row.key, () => ({ instructions }))}
                />

                {row.type === "noul" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <JsonTextArea
                      label="Yes means (optional)"
                      value={row.yes}
                      onChange={(yes) => update(row.key, () => ({ yes }))}
                    />
                    <JsonTextArea
                      label="No means (optional)"
                      value={row.no}
                      onChange={(no) => update(row.key, () => ({ no }))}
                    />
                  </div>
                ) : null}

                {row.type === "choice" ? (
                  <div className="space-y-2">
                    <p className={labelClass}>Options</p>
                    {row.options.map((option) => (
                      <div key={option.key} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                        <input
                          aria-label="Option name"
                          value={option.name}
                          maxLength={100}
                          placeholder="billing"
                          onChange={(event) =>
                            update(row.key, (r) => ({
                              options: r.options.map((o) =>
                                o.key === option.key ? { ...o, name: event.target.value } : o,
                              ),
                            }))
                          }
                          className={inputClass}
                        />
                        <input
                          aria-label="Option description"
                          value={option.description.text}
                          placeholder="What this option means"
                          onChange={(event) =>
                            update(row.key, (r) => ({
                              options: r.options.map((o) =>
                                o.key === option.key
                                  ? {
                                      ...o,
                                      description: { ...o.description, text: event.target.value },
                                    }
                                  : o,
                              ),
                            }))
                          }
                          className={inputClass}
                        />
                        <button
                          type="button"
                          className={removeClass}
                          onClick={() =>
                            update(row.key, (r) => ({
                              options: r.options.filter((o) => o.key !== option.key),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className={buttonStyles.ghost}
                      onClick={() =>
                        update(row.key, (r) => ({
                          options: [
                            ...r.options,
                            { key: newRowKey(), name: "", description: EMPTY },
                          ],
                        }))
                      }
                    >
                      Add option
                    </button>
                  </div>
                ) : null}

                {row.type === "score" ? (
                  <div className="space-y-2">
                    <p className={labelClass}>
                      Levels, lowest first (the score is the level's number)
                    </p>
                    {row.levels.map((level, position) => (
                      <div key={level.key} className="grid gap-2 sm:grid-cols-[2rem_1fr_auto_auto]">
                        <span className="pt-2 text-sm text-muted">{position}</span>
                        <input
                          aria-label={`Level ${position} description`}
                          value={level.description.text}
                          placeholder="What this level means"
                          onChange={(event) =>
                            update(row.key, (r) => ({
                              levels: r.levels.map((l) =>
                                l.key === level.key
                                  ? {
                                      ...l,
                                      description: { ...l.description, text: event.target.value },
                                    }
                                  : l,
                              ),
                            }))
                          }
                          className={inputClass}
                        />
                        <button
                          type="button"
                          className="text-sm text-muted hover:underline disabled:opacity-40"
                          disabled={position === 0}
                          onClick={() =>
                            update(row.key, (r) => {
                              const levels = r.levels.filter((l) => l.key !== level.key);
                              levels.splice(position - 1, 0, level);
                              return { levels };
                            })
                          }
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          className={removeClass}
                          onClick={() =>
                            update(row.key, (r) => ({
                              levels: r.levels.filter((l) => l.key !== level.key),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className={buttonStyles.ghost}
                      onClick={() =>
                        update(row.key, (r) => ({
                          levels: [...r.levels, { key: newRowKey(), description: EMPTY }],
                        }))
                      }
                    >
                      Add level
                    </button>
                  </div>
                ) : null}

                <button
                  type="button"
                  className={removeClass}
                  onClick={() => {
                    setQuestions((rows) => rows.filter((r) => r.key !== row.key));
                    setDirty(true);
                  }}
                >
                  Remove question {index + 1}
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
