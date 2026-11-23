"use client";
// The prompt editor (ADR 0017): Milkdown Crepe for rich editing, a plain textarea for the markdown source.
// It stores markdown: an untouched document posts back the exact text it was given, and an edited one is serialized
// by remark (normalized, never lossy on XML-like tags, `{{variables}}` or code; plan 0004, P2).
// Crepe touches the DOM when imported, so it loads in an effect, never during server rendering.
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import type { CrepeBuilder } from "@milkdown/crepe/builder";
import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "rich" | "source";

export function MarkdownEditor(props: {
  name: string;
  defaultValue: string;
  onChange?: (markdown: string) => void;
  id?: string;
  placeholder?: string;
  "aria-labelledby"?: string;
}) {
  const { name, defaultValue, onChange, id, placeholder } = props;
  const labelledBy = props["aria-labelledby"];
  const [mode, setMode] = useState<Mode>("rich");
  const [markdown, setMarkdown] = useState(defaultValue);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Read by the editor's callbacks, which outlive a render.
  const markdownRef = useRef(defaultValue);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const inputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Brings the markdown up to date with the rich document; null while the rich editor is not mounted.
  const flushRef = useRef<(() => void) | null>(null);

  const update = useCallback((next: string) => {
    if (next === markdownRef.current) return;
    markdownRef.current = next;
    // Set the input directly too, so a form submitted in this same event posts the new text.
    if (inputRef.current) inputRef.current.value = next;
    setMarkdown(next);
    onChangeRef.current?.(next);
  }, []);

  // Crepe reports edits after a 200 ms debounce. Whoever reads the form (a native submit or React's server action)
  // builds a FormData, which fires `formdata`: flush there so a quick save never loses the last keystrokes.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const flush = (event: FormDataEvent) => {
      flushRef.current?.();
      event.formData.set(name, markdownRef.current);
    };
    form.addEventListener("formdata", flush);
    return () => form.removeEventListener("formdata", flush);
  }, [name]);

  useEffect(() => {
    if (mode !== "rich") return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    // Each instance mounts into its own element, so a slow import from a superseded effect never touches the next one.
    const mount = host.appendChild(document.createElement("div"));
    let created: CrepeBuilder | null = null;
    setLoading(true);
    setFailed(false);

    (async () => {
      const [
        { CrepeBuilder },
        { blockEdit },
        { codeMirror },
        { cursor },
        { linkTooltip },
        { listItem },
        { placeholder: placeholderFeature },
        { table },
        { toolbar },
        { editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx },
      ] = await Promise.all([
        import("@milkdown/crepe/builder"),
        import("@milkdown/crepe/feature/block-edit"),
        import("@milkdown/crepe/feature/code-mirror"),
        import("@milkdown/crepe/feature/cursor"),
        import("@milkdown/crepe/feature/link-tooltip"),
        import("@milkdown/crepe/feature/list-item"),
        import("@milkdown/crepe/feature/placeholder"),
        import("@milkdown/crepe/feature/table"),
        import("@milkdown/crepe/feature/toolbar"),
        import("@milkdown/kit/core"),
      ]);
      if (cancelled) return;

      const editor = new CrepeBuilder({ root: mount, defaultValue: markdownRef.current });
      const attributes: Record<string, string> = { role: "textbox", "aria-multiline": "true" };
      if (id) attributes.id = id;
      if (labelledBy) attributes["aria-labelledby"] = labelledBy;
      editor.editor.config((ctx) => {
        // Write lists and rules the way people type them: `-` bullets, `---` rules.
        ctx.update(remarkStringifyOptionsCtx, (options) => ({
          ...options,
          bullet: "-" as const,
          rule: "-" as const,
        }));
        ctx.update(editorViewOptionsCtx, (options) => ({ ...options, attributes }));
      });
      // No images (prompts are text) and no LaTeX (its `$` parsing would escape every dollar sign).
      editor
        .addFeature(cursor)
        .addFeature(listItem)
        .addFeature(linkTooltip)
        .addFeature(blockEdit)
        .addFeature(placeholderFeature, {
          text: placeholder ?? "Type / for headings, lists, tables and code",
          mode: "doc",
        })
        .addFeature(toolbar)
        .addFeature(codeMirror)
        .addFeature(table);

      // The markdown it was given, kept byte for byte until the document actually changes.
      const loaded = markdownRef.current;
      editor.on((listener) => {
        listener.updated(() => flushRef.current?.());
        listener.blur(() => flushRef.current?.());
      });
      await editor.create();
      if (cancelled) {
        await editor.destroy();
        mount.remove();
        return;
      }
      created = editor;
      const initialDoc = editor.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
      flushRef.current = () => {
        const doc = editor.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
        update(doc.eq(initialDoc) ? loaded : editor.getMarkdown());
      };
      setLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setLoading(false);
        setFailed(true);
        setMode("source");
      }
    });

    return () => {
      cancelled = true;
      flushRef.current?.();
      flushRef.current = null;
      if (created) void created.destroy().then(() => mount.remove());
      else mount.remove();
    };
  }, [mode, id, labelledBy, placeholder, update]);

  const switchTo = (next: Mode) => {
    if (next === mode) return;
    flushRef.current?.();
    setMode(next);
  };

  return (
    <div className="kerby-markdown-editor rounded-lg border border-line bg-panel shadow-sm focus-within:outline-2 focus-within:outline-brand">
      <div className="flex items-center justify-between gap-3 rounded-t-lg border-b border-line bg-page px-3 py-1.5">
        <p className="text-xs text-muted">
          {mode === "rich"
            ? "Type / for blocks. Tags like <instructions> show as written; edit them in Markdown."
            : "Markdown source, saved exactly as written."}
        </p>
        <fieldset className="inline-flex rounded-md border border-line bg-panel p-0.5">
          <legend className="sr-only">Editor mode</legend>
          {(["rich", "source"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => switchTo(option)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === option
                  ? "bg-brand text-on-brand"
                  : "text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {option === "rich" ? "Rich text" : "Markdown"}
            </button>
          ))}
        </fieldset>
      </div>
      {mode === "rich" ? (
        <div className="relative">
          {loading ? (
            <p className="absolute inset-x-0 top-0 px-5 py-4 text-sm text-muted">Loading editor…</p>
          ) : null}
          <div ref={hostRef} className="min-h-64" />
        </div>
      ) : (
        <>
          {failed ? (
            <p
              role="alert"
              className="border-b border-line bg-brand/10 px-3 py-1.5 text-xs text-brand-text"
            >
              The rich editor could not load; edit the markdown here, or reload the page to try it
              again.
            </p>
          ) : null}
          <textarea
            id={id}
            aria-labelledby={labelledBy}
            value={markdown}
            onChange={(event) => update(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            className="block min-h-64 w-full resize-y border-0 bg-panel px-4 py-3 font-mono text-sm leading-6 text-fg placeholder:text-muted/60 focus:outline-none"
            rows={16}
          />
        </>
      )}
      <input ref={inputRef} type="hidden" name={name} value={markdown} />
    </div>
  );
}
