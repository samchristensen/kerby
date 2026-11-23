// `{{variable}}` substitution and the checks a draft passes before it is published (ADR 0017). Pure functions: the api
// renders a version with them, the console renders a draft in its playground. No template language: a `{{ name }}`
// whose name is declared is replaced verbatim, anything else is literal text.
import {
  MAX_PROMPT_TEXT,
  MAX_QUESTIONS,
  type PromptBody,
  type PromptVariable,
  type PromptVariableValues,
} from "@kerby/contracts";

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;

/** Every variable name the text refers to as `{{ name }}`, once each, in order of first appearance. */
export function templateVariables(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(VARIABLE), (match) => match[1] ?? ""))];
}

/** The values given do not fit the prompt's variables, or the rendered text is too long. */
export class InvalidVariablesError extends Error {
  override name = "InvalidVariablesError";
  /** Declared variables without a default that were not given. */
  readonly missing: string[];
  /** Given variables the prompt does not declare. */
  readonly unknown: string[];
  constructor(message: string, missing: string[] = [], unknown: string[] = []) {
    super(message);
    this.missing = missing;
    this.unknown = unknown;
  }
}

/**
 * The text with each declared `{{ name }}` replaced by its value, or its default. A variable without a default must be
 * given, and every value given must be declared; an undeclared `{{ name }}` in the text stays as it is (only a draft can
 * have one). The result is at most `MAX_PROMPT_TEXT` characters, like any system prompt.
 */
export function renderTemplate(
  text: string,
  declared: readonly PromptVariable[],
  values: PromptVariableValues,
): string {
  const byName = new Map(declared.map((variable) => [variable.name, variable]));
  const unknown = Object.keys(values).filter((name) => !byName.has(name));
  const missing = declared
    .filter((variable) => variable.default === undefined && !Object.hasOwn(values, variable.name))
    .map((variable) => variable.name);
  if (missing.length > 0 || unknown.length > 0) {
    const problems = [
      ...(missing.length > 0 ? [`give a value for ${missing.join(", ")}`] : []),
      ...(unknown.length > 0
        ? [
            `the prompt declares no ${unknown.join(", ")}: leave ${unknown.length > 1 ? "them" : "it"} out`,
          ]
        : []),
    ];
    throw new InvalidVariablesError(
      `variables do not fit the prompt: ${problems.join("; ")}`,
      missing,
      unknown,
    );
  }
  const rendered = text.replace(VARIABLE, (match, name: string) => {
    const variable = byName.get(name);
    if (!variable) return match;
    return Object.hasOwn(values, name) ? (values[name] ?? "") : (variable.default ?? "");
  });
  if (rendered.length > MAX_PROMPT_TEXT)
    throw new InvalidVariablesError(
      `the prompt with these variables is ${rendered.length} characters, past the ${MAX_PROMPT_TEXT} a system prompt may have: shorten the values`,
    );
  return rendered;
}

/** Why a draft cannot be published, one sentence per problem; empty when it can. Model names are checked by the api. */
export function publishProblems(body: PromptBody): string[] {
  if (body.kind === "decision") {
    const count = Object.keys(body.questions).length;
    return count >= 1 && count <= MAX_QUESTIONS
      ? []
      : [`a decision model asks 1 to ${MAX_QUESTIONS} questions: it has ${count}`];
  }
  const problems: string[] = [];
  if (body.text.trim() === "") problems.push("the text is empty: write the system prompt");
  const used = templateVariables(body.text);
  const declared = body.variables.map((variable) => variable.name);
  const undeclared = used.filter((name) => !declared.includes(name));
  const unused = declared.filter((name) => !used.includes(name));
  if (undeclared.length > 0)
    problems.push(
      `the text uses ${undeclared.map((name) => `{{${name}}}`).join(", ")} without declaring it: add it to variables`,
    );
  if (unused.length > 0)
    problems.push(
      `${unused.join(", ")} ${unused.length > 1 ? "are" : "is"} declared but not in the text: use {{${unused[0]}}} in the text or remove the variable`,
    );
  return problems;
}
