"use client";
// Save and publish, shared by both editors. A save names the revision the editor started from; a draft changed
// elsewhere since is refused, and the person is offered the latest one. Publishing takes the saved draft only.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, buttonStyles } from "../../../_components/ui.tsx";
import { publishPromptAction, saveDraftAction } from "../actions.ts";
import { inputClass } from "./shared.ts";

type Notice = { tone: "error" | "success"; text: string; conflict?: boolean };

export function DraftBar({
  name,
  revision,
  dirty,
  build,
}: {
  name: string;
  revision: number;
  /** Changed since the last save: publishing waits for a save. */
  dirty: boolean;
  /** The draft to save; throws an `Error` whose message says what to fix. */
  build: () => Promise<unknown>;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | undefined>();
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      let draft: unknown;
      try {
        draft = await build();
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
        return;
      }
      const result = await saveDraftAction(name, revision, draft);
      // On success the page reloads the prompt and the editor starts again from the saved revision.
      if (!result.ok) {
        setNotice({
          tone: "error",
          text: result.error ?? "The draft was refused.",
          ...(result.conflict ? { conflict: true } : {}),
        });
      }
    });

  const publish = () =>
    startTransition(async () => {
      const result = await publishPromptAction(name, revision, note);
      if (result.ok) {
        setNote("");
        setNotice({ tone: "success", text: `Published version ${result.version}.` });
      } else {
        setNotice({
          tone: "error",
          text: result.error ?? "The draft could not be published.",
          ...(result.conflict ? { conflict: true } : {}),
        });
      }
    });

  return (
    <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      {notice ? (
        <Alert tone={notice.tone}>
          <span className="whitespace-pre-wrap">{notice.text}</span>
          {notice.conflict ? (
            <button
              type="button"
              className="ml-2 font-medium underline"
              onClick={() => {
                setNotice(undefined);
                router.refresh();
              }}
            >
              Reload the draft
            </button>
          ) : null}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonStyles.primary} disabled={pending} onClick={save}>
          {pending ? "Working…" : "Save draft"}
        </button>
        <span className="text-xs text-zinc-500">
          {dirty ? "Unsaved changes." : `Saved (revision ${revision}).`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
        <input
          aria-label="Publish note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          placeholder="What changed (optional)"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button
          type="button"
          className={buttonStyles.secondary}
          disabled={pending || dirty}
          title={dirty ? "Save the draft before publishing it." : undefined}
          onClick={publish}
        >
          Publish
        </button>
      </div>
    </div>
  );
}
