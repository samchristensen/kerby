import { MAX_PROMPT_TEXT, type PromptBody } from "@kerby/contracts";
import { describe, expect, it } from "vitest";
import {
  InvalidVariablesError,
  publishProblems,
  renderTemplate,
  templateVariables,
} from "./index.ts";

describe("templateVariables", () => {
  it("finds each {{ name }} once, in order, with spaces inside the braces allowed", () => {
    expect(templateVariables("Hi {{user}}, about {{ topic }} for {{user}}.")).toEqual([
      "user",
      "topic",
    ]);
  });

  it("leaves anything that is not a variable as text", () => {
    expect(templateVariables("{{ 9lives }} {user} {{a-b}} {{}} {{ x y }} `{{#if}}`")).toEqual([]);
    expect(templateVariables(`{{${"a".repeat(65)}}}`)).toEqual([]);
  });
});

describe("renderTemplate", () => {
  const declared = [{ name: "user" }, { name: "tone", default: "warm" }];

  it("puts values in verbatim, defaults where none is given, and leaves undeclared names as text", () => {
    expect(
      renderTemplate("{{user}} {{ tone }} {{other}}", declared, { user: "$& {{tone}} $1" }),
    ).toBe("$& {{tone}} $1 warm {{other}}");
    expect(renderTemplate("{{tone}}", declared, { user: "a", tone: "" })).toBe("");
  });

  it("names every missing and unknown variable", () => {
    const error = (() => {
      try {
        renderTemplate("{{user}}", declared, { extra: "x", __proto__x: "y" });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(InvalidVariablesError);
    expect(error).toMatchObject({ missing: ["user"], unknown: ["extra", "__proto__x"] });
    expect((error as Error).message).toContain("give a value for user");
  });

  it("refuses a result longer than a system prompt may be", () => {
    expect(() =>
      renderTemplate("{{user}}{{user}}", declared, { user: "x".repeat(MAX_PROMPT_TEXT / 2 + 1) }),
    ).toThrow(InvalidVariablesError);
  });
});

describe("publishProblems", () => {
  const chat = (text: string, names: string[]): PromptBody => ({
    kind: "chat",
    text,
    guardrails: [],
    variables: names.map((name) => ({ name })),
  });

  it("passes a chat prompt that declares exactly the variables its text uses", () => {
    expect(publishProblems(chat("Help {{user}}.", ["user"]))).toEqual([]);
  });

  it("lists every problem of a chat prompt", () => {
    expect(publishProblems(chat("  ", []))).toEqual(["the text is empty: write the system prompt"]);
    const problems = publishProblems(chat("Help {{user}}.", ["tone"]));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("{{user}}");
    expect(problems[1]).toContain("tone is declared but not in the text");
  });

  it("wants 1 or more questions in a decision model", () => {
    expect(publishProblems({ kind: "decision", questions: {} })).toEqual([
      "a decision model asks 1 to 32 questions: it has 0",
    ]);
    expect(
      publishProblems({
        kind: "decision",
        questions: { billing: { type: "noul", instructions: "Is it about billing?" } },
      }),
    ).toEqual([]);
  });
});
