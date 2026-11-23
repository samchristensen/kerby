"use client";
// The decision playground: a real judgment of a state pasted as JSON, by the saved draft or a version, shown with each
// question's probabilities.
import type { AnswerSchema, Judgment, Prompt } from "@kerby/contracts";
import { useEffect, useRef, useState, useTransition } from "react";
import type { z } from "zod";
import { Alert, buttonStyles, Card } from "../../../_components/ui.tsx";
import { judgmentAction, runDecisionAction } from "../actions.ts";
import { inputClass, labelClass, versionChoices } from "./shared.ts";

type Answer = z.infer<typeof AnswerSchema>;

const POLL_MS = 1_000;
/** A judgment still running after this long is left to finish on its own; the page stops asking. */
const POLL_LIMIT_MS = 120_000;

const percent = (p: number) => `${(p * 100).toFixed(1)}%`;

function Bar({
  label,
  probability,
  strong,
}: {
  label: string;
  probability: number;
  strong?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr_4rem] items-center gap-2 text-sm">
      <span className={`truncate ${strong ? "font-semibold text-fg" : "text-muted"}`}>{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-raised">
        <span className="block h-full bg-brand" style={{ width: percent(probability) }} />
      </span>
      <span className="text-right tabular-nums text-fg">{percent(probability)}</span>
    </div>
  );
}

function AnswerView({ name, answer }: { name: string; answer: Answer }) {
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <p className="text-sm font-semibold text-fg">
        <code className="font-mono">{name}</code>{" "}
        <span className="font-normal text-muted">
          {answer.type === "noul"
            ? `yes with probability ${percent(answer.probability)}`
            : answer.type === "choice"
              ? `${answer.choice} (confidence ${percent(answer.confidence)})`
              : `score ${answer.score} (confidence ${percent(answer.confidence)})`}
        </span>
      </p>
      {answer.type === "noul" ? <Bar label="yes" probability={answer.probability} strong /> : null}
      {answer.type === "choice"
        ? Object.entries(answer.probabilities)
            .sort(([, a], [, b]) => b - a)
            .map(([choice, probability]) => (
              <Bar
                key={choice}
                label={choice}
                probability={probability}
                strong={choice === answer.choice}
              />
            ))
        : null}
      {answer.type === "score"
        ? answer.probabilities.map((probability, level) => (
            <Bar
              // Levels are positions: their order is their meaning, so the index is the key.
              key={level}
              label={`level ${level}`}
              probability={probability}
              strong={level === Math.round(answer.score)}
            />
          ))
        : null}
    </li>
  );
}

type Run = {
  id: string;
  startedAt: number;
  judgment?: Judgment;
  elapsedMs?: number;
  gaveUp?: boolean;
};

export function DecisionPlayground({ prompt }: { prompt: Prompt }) {
  const [source, setSource] = useState("draft");
  const [state, setState] = useState("{\n  \n}");
  const [error, setError] = useState<{ field?: string; form?: string } | undefined>();
  const [run, setRun] = useState<Run | undefined>();
  const [pending, startTransition] = useTransition();
  const runId = run?.id;
  const startedAt = run?.startedAt;
  const runRef = useRef(runId);
  runRef.current = runId;

  useEffect(() => {
    if (!runId || startedAt === undefined) return;
    let timer = 0;
    const poll = async () => {
      const judgment = await judgmentAction(runId).catch(() => undefined);
      if (runRef.current !== runId) return;
      const elapsedMs = Date.now() - startedAt;
      const settled = judgment && judgment.status !== "pending" && judgment.status !== "running";
      if (settled || elapsedMs >= POLL_LIMIT_MS) {
        setRun({
          id: runId,
          startedAt,
          ...(judgment ? { judgment } : {}),
          elapsedMs,
          gaveUp: !settled,
        });
        return;
      }
      setRun((current) => (current?.id === runId && judgment ? { ...current, judgment } : current));
      timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS / 2);
    return () => window.clearTimeout(timer);
  }, [runId, startedAt]);

  const submit = () =>
    startTransition(async () => {
      setError(undefined);
      setRun(undefined);
      const result = await runDecisionAction(prompt.name, source, state);
      if (!result.ok) {
        setError({
          ...(result.fields?.state ? { field: result.fields.state } : {}),
          ...(result.error ? { form: result.error } : {}),
        });
        return;
      }
      setRun({ id: result.id, startedAt: Date.now() });
    });

  const judgment = run?.judgment;
  const running = run !== undefined && run.elapsedMs === undefined;
  return (
    <div className="space-y-6">
      <Card title="Run a judgment">
        <div className="space-y-4">
          <label className={labelClass}>
            Run
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className={`${inputClass} mt-1.5`}
            >
              <option value="draft">The saved draft</option>
              {versionChoices(prompt).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            State (JSON)
            <textarea
              value={state}
              rows={10}
              spellCheck={false}
              onChange={(event) => setState(event.target.value)}
              aria-invalid={error?.field ? true : undefined}
              className={`${inputClass} mt-1.5 font-mono font-normal`}
            />
          </label>
          {error?.field ? <p className="text-sm text-danger">{error.field}</p> : null}
          {error?.form ? <Alert tone="error">{error.form}</Alert> : null}
          <button
            type="button"
            className={buttonStyles.primary}
            disabled={pending || running}
            onClick={submit}
          >
            {pending || running ? "Running…" : "Run"}
          </button>
        </div>
      </Card>

      {run ? (
        <Card title="Result">
          {running ? (
            <p className="text-sm text-muted">
              {judgment?.status === "running" ? "Running…" : "Waiting for a worker…"}
            </p>
          ) : judgment?.status === "answered" ? (
            <div className="space-y-4">
              <p className="text-xs text-muted">
                Answered by <code className="font-mono">{judgment.servedModel}</code> in{" "}
                {((run.elapsedMs ?? 0) / 1000).toFixed(1)} s · {judgment.usage.inputTokens} input
                and {judgment.usage.outputTokens} output tokens
              </p>
              <ul className="divide-y divide-line">
                {Object.entries(judgment.answers).map(([name, answer]) => (
                  <AnswerView key={name} name={name} answer={answer} />
                ))}
              </ul>
            </div>
          ) : judgment?.status === "refused" ? (
            <Alert tone="error">
              <p>Refused: {judgment.error}</p>
              <p className="mt-1">
                Running it again gives the same result: fix the model, its key or the questions.
              </p>
            </Alert>
          ) : judgment?.status === "failed" ? (
            <Alert tone="error">
              <p>Failed: {judgment.error}</p>
              <p className="mt-1">Running it again may succeed.</p>
            </Alert>
          ) : (
            <Alert tone="warning">
              No answer after {POLL_LIMIT_MS / 1000} seconds. It may still finish; run it again
              later.
            </Alert>
          )}
        </Card>
      ) : null}
    </div>
  );
}
