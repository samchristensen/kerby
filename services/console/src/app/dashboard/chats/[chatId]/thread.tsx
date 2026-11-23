"use client";
// One conversation: its messages, the answer as it is written, and the box to talk back. The page's data is the
// conversation as the server read it; from there the event stream keeps it current, so a message posted by the tenant's
// own code through the API shows up here too. The persisted messages are the record: live text is only a preview.
import type { EventEnvelope, PublicMessage } from "@kerby/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatView } from "../../../../types/index.ts";
import { formatDateTime } from "../../../_components/format.ts";
import { Alert, Badge, Mascot } from "../../../_components/ui.tsx";
import { chatStatusAction, sendMessageAction } from "../actions.ts";

type Entry = ChatView["messages"][number];
type Content = Extract<PublicMessage, { role: "user" }>["content"];
type ToolResult = Extract<PublicMessage, { role: "tool" }>;

/** The events the stream names; `tool_start` and `tool_end` add nothing the persisted messages do not show. */
const STREAM_EVENTS = [
  "run_start",
  "message_start",
  "text_delta",
  "message_end",
  "run_end",
] as const;

/** While a turn runs, ask the api this often whether it is still running: the backstop for a live event not seen. */
const STATUS_POLL_MS = 4_000;
/** After a final answer arrives, look at once: the turn's task closes a moment after its last message. */
const AFTER_ANSWER_MS = 400;
const NEAR_BOTTOM_PX = 120;

const resultText = (result: ToolResult): string =>
  result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.mediaType}]`))
    .join("\n");

function Parts({ content }: { content: Content }) {
  return (
    <>
      {content.map((part, index) =>
        part.type === "text" ? (
          <p key={index} className="break-words whitespace-pre-wrap">
            {part.text}
          </p>
        ) : (
          <p key={index} className="text-xs italic opacity-70">
            Attachment ({part.mediaType})
          </p>
        ),
      )}
    </>
  );
}

function ToolCall({
  call,
  result,
  running,
}: {
  call: { id: string; name: string; input: unknown };
  result: ToolResult | undefined;
  running: boolean;
}) {
  const status = result ? (result.isError ? "failed" : "done") : running ? "running…" : "no result";
  return (
    <details className="rounded-lg border border-line bg-page text-sm">
      <summary className="cursor-pointer px-3 py-2 text-fg">
        <span className="font-mono text-xs">{call.name}</span>
        <span className={`ml-2 text-xs ${result?.isError ? "text-danger" : "text-muted"}`}>
          {status}
        </span>
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-2">
        <pre className="overflow-x-auto font-mono text-xs break-words whitespace-pre-wrap text-fg">
          {JSON.stringify(call.input, null, 2)}
        </pre>
        {result ? (
          <pre className="overflow-x-auto border-t border-line pt-2 font-mono text-xs break-words whitespace-pre-wrap text-fg">
            {resultText(result)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}

function MessageView({
  entry,
  results,
  busy,
}: {
  entry: Entry;
  results: Map<string, ToolResult>;
  busy: boolean;
}) {
  const { message } = entry;
  // A tool's result is shown inside the call that asked for it.
  if (message.role === "tool") return null;
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm text-on-brand">
          <Parts content={message.content} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2 rounded-2xl rounded-bl-md border border-line bg-panel px-4 py-2.5 text-sm text-fg shadow-sm">
        {message.content.map((part, index) =>
          part.type === "tool_call" ? (
            <ToolCall key={index} call={part} result={results.get(part.id)} running={busy} />
          ) : (
            <Parts key={index} content={[part]} />
          ),
        )}
      </div>
    </div>
  );
}

export function ChatThread({ chat }: { chat: ChatView }) {
  const [messages, setMessages] = useState(chat.messages);
  const [live, setLive] = useState<string | null>(null);
  const [busy, setBusy] = useState(chat.busy);
  const [error, setError] = useState(chat.lastError);
  const [connection, setConnection] = useState<"open" | "reconnecting" | "closed">("reconnecting");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const seen = useRef(chat.messages.at(-1)?.seq ?? 0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  /** Ask the api whether the turn is still running: the backstop for a `run_end` this page never saw. */
  const checkStatus = useCallback(async () => {
    const status = await chatStatusAction(chat.id).catch(() => undefined);
    if (status && !status.busy) {
      setBusy(false);
      setLive(null);
      setError(status.lastError);
    }
  }, [chat.id]);

  useEffect(() => {
    const apply = ({ seq, at, event }: EventEnvelope) => {
      switch (event.type) {
        case "run_start":
          setBusy(true);
          break;
        case "message_start":
          setLive("");
          break;
        case "text_delta":
          setLive((text) => (text ?? "") + event.text);
          break;
        case "message_end":
          // Only persisted messages come through here; one at or before what the page has is a replay.
          if (seq > seen.current) {
            seen.current = seq;
            setMessages((all) => [...all, { seq, message: event.message, createdAt: at }]);
            if (event.message.role === "assistant") {
              setLive(null);
              // The turn is over unless the model asked for a tool; the task closes a moment after its last message.
              if (event.message.stopReason !== "tool_use") setTimeout(checkStatus, AFTER_ANSWER_MS);
            }
            // Someone else (the tenant's own code) posted: an answer is on its way.
            if (event.message.role === "user") setBusy(true);
          }
          break;
        case "run_end":
          setLive(null);
          setBusy(false);
          if (event.error) setError(event.error);
          break;
        default:
          break;
      }
    };
    // A reconnect resumes by itself from the last message id; this first one starts after what the page holds.
    const source = new EventSource(`/dashboard/chats/${chat.id}/events?after=${seen.current}`);
    source.onopen = () => setConnection("open");
    source.onerror = () =>
      setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    for (const type of STREAM_EVENTS) {
      source.addEventListener(type, (message) => {
        apply(JSON.parse((message as MessageEvent<string>).data) as EventEnvelope);
      });
    }
    return () => source.close();
  }, [chat.id, checkStatus]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void checkStatus(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, checkStatus]);

  // Follow the conversation as it grows, unless the person scrolled up to read.
  useEffect(() => {
    const element = scroller.current;
    if (element && stickToBottom.current) element.scrollTo({ top: element.scrollHeight });
  }, [messages.length, live, busy]);

  async function send() {
    const message = draft.trim();
    if (!message || busy || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await sendMessageAction(chat.id, message);
      if (result.ok) {
        setDraft("");
        setBusy(true);
        setError(null);
        stickToBottom.current = true;
      } else {
        setSendError(result.fields?.message ?? result.error ?? "The message was not sent.");
      }
    } catch {
      setSendError("Could not reach the server. Try again.");
    } finally {
      setSending(false);
    }
  }

  const results = new Map<string, ToolResult>();
  for (const { message } of messages)
    if (message.role === "tool") results.set(message.toolCallId, message);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-6">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-fg">
            {chat.title ?? "Untitled chat"}
          </h1>
          <p className="truncate text-xs text-muted">
            <code className="font-mono">{chat.model}</code>
            {chat.prompt ? (
              <>
                {" · "}
                <code className="font-mono">
                  {chat.prompt.name}@v{chat.prompt.version}
                </code>
              </>
            ) : null}{" "}
            · started {formatDateTime(chat.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connection === "reconnecting" ? (
            <span className="text-xs text-muted">Reconnecting…</span>
          ) : connection === "closed" ? (
            <span className="text-xs text-danger">Disconnected. Reload the page.</span>
          ) : null}
          {chat.origin === "console" ? (
            <Badge tone="brand">Console</Badge>
          ) : chat.origin === "studio" ? (
            <Badge tone="live">Studio</Badge>
          ) : (
            <Badge tone="neutral">
              {chat.externalUserId ? `API · ${chat.externalUserId}` : "API"}
            </Badge>
          )}
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {chat.system ? (
            <details className="rounded-lg border border-dashed border-line text-sm text-muted">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                System prompt
              </summary>
              <p className="border-t border-dashed border-line px-3 py-2 break-words whitespace-pre-wrap">
                {chat.system}
              </p>
            </details>
          ) : null}
          {messages.length === 0 && !busy ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted">
              <Mascot state="friendly" size={96} />
              <p>No messages yet. Say something.</p>
            </div>
          ) : null}
          {messages.map((entry) => (
            <MessageView key={entry.seq} entry={entry} results={results} busy={busy} />
          ))}
          {live ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-line bg-panel px-4 py-2.5 text-sm break-words whitespace-pre-wrap text-fg shadow-sm">
                {live}
                <span className="ml-0.5 animate-pulse text-muted">▍</span>
              </div>
            </div>
          ) : busy ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Mascot state="thinking" size={48} />
              <span className="animate-pulse">Working…</span>
            </div>
          ) : null}
          {error && !busy ? <Alert tone="error">{error}</Alert> : null}
        </div>
      </div>

      <footer className="shrink-0 border-t border-line bg-panel px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {sendError ? <p className="mb-2 text-sm text-danger">{sendError}</p> : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="flex items-end gap-3"
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={2}
              maxLength={1_000_000}
              aria-label="Message"
              placeholder={
                busy
                  ? "Waiting for the reply…"
                  : "Write a message. Enter sends, Shift+Enter adds a line."
              }
              className="block max-h-48 min-h-11 w-full resize-y rounded-lg border border-line bg-page px-3 py-2 text-sm text-fg shadow-sm placeholder:text-muted/60 focus:outline-2 focus:outline-brand"
            />
            <button
              type="submit"
              disabled={busy || sending || draft.trim() === ""}
              className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-on-brand shadow-sm hover:bg-brand/85 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </div>
      </footer>
    </div>
  );
}
