import type {
  AgentEvent,
  AgentMessage,
  ContentPart,
  ToolCall,
  ToolResult,
  Usage,
} from "@kerby/agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  type AgentEventSchema,
  type AgentMessageSchema,
  type ContentPartSchema,
  CreateTenantRequestSchema,
  EventEnvelopeSchema,
  GetConversationQuerySchema,
  GetConversationResponseSchema,
  PostMessageRequestSchema,
  type ToolCallSchema,
  type ToolResultSchema,
  type UsageSchema,
} from "./index.ts";

describe("schemas match the AgentRuntime port", () => {
  // Compile-time: a drifting schema or type fails `make check`.
  it("types are identical", () => {
    expectTypeOf<z.infer<typeof ContentPartSchema>>().toEqualTypeOf<ContentPart>();
    expectTypeOf<z.infer<typeof ToolCallSchema>>().toEqualTypeOf<ToolCall>();
    expectTypeOf<z.infer<typeof UsageSchema>>().toEqualTypeOf<Usage>();
    expectTypeOf<z.infer<typeof ToolResultSchema>>().toEqualTypeOf<ToolResult>();
    expectTypeOf<z.infer<typeof AgentMessageSchema>>().toEqualTypeOf<AgentMessage>();
    expectTypeOf<z.infer<typeof AgentEventSchema>>().toEqualTypeOf<AgentEvent>();
  });
});

const assistant = {
  role: "assistant",
  model: "faux",
  stopReason: "tool_use",
  content: [
    { type: "text", text: "checking" },
    { type: "tool_call", id: "call_1", name: "echo", input: { text: "hi" } },
  ],
  usage: { inputTokens: 3, outputTokens: 4 },
  native: { thinking: "secret chain of thought" },
} as const;

describe("event envelope", () => {
  const envelope = {
    v: 1,
    conversationId: "6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11",
    runId: "run-1",
    seq: 7,
    at: "2026-11-21T10:00:00.000Z",
    event: { type: "message_end", message: assistant },
  };

  it("round-trips a persisted event", () => {
    expect(EventEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects an unknown version, a malformed event, and a non-uuid conversation", () => {
    expect(EventEnvelopeSchema.safeParse({ ...envelope, v: 2 }).success).toBe(false);
    expect(
      EventEnvelopeSchema.safeParse({ ...envelope, event: { type: "message_end" } }).success,
    ).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...envelope, conversationId: "c1" }).success).toBe(
      false,
    );
  });
});

describe("conversation response", () => {
  it("never exposes the harness's native payload", () => {
    const parsed = GetConversationResponseSchema.parse({
      conversation: {
        id: "6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11",
        externalUserId: null,
        model: "faux",
        system: "",
        createdAt: "2026-11-21T10:00:00.000Z",
      },
      messages: [{ seq: 1, message: assistant, createdAt: "2026-11-21T10:00:01.000Z" }],
      nextAfter: null,
      busy: false,
      lastError: null,
    });
    expect(JSON.stringify(parsed)).not.toContain("chain of thought");
    expect(parsed.messages[0]?.message).not.toHaveProperty("native");
  });
});

describe("requests", () => {
  it("accepts text or content parts and rejects empty input", () => {
    expect(PostMessageRequestSchema.safeParse({ content: "hello" }).success).toBe(true);
    expect(
      PostMessageRequestSchema.safeParse({ content: [{ type: "text", text: "hello" }] }).success,
    ).toBe(true);
    expect(PostMessageRequestSchema.safeParse({ content: "" }).success).toBe(false);
    expect(PostMessageRequestSchema.safeParse({ content: [] }).success).toBe(false);
    expect(PostMessageRequestSchema.safeParse({}).success).toBe(false);
  });

  it("pages a conversation read: after 0 or more, limit 1 to 500, default 100", () => {
    expect(GetConversationQuerySchema.parse({})).toEqual({ after: 0, limit: 100 });
    expect(GetConversationQuerySchema.parse({ after: "7", limit: "500" })).toEqual({
      after: 7,
      limit: 500,
    });
    for (const bad of [{ after: "-1" }, { limit: "0" }, { limit: "501" }, { after: "1.5" }])
      expect(GetConversationQuerySchema.safeParse(bad).success).toBe(false);
  });

  it("only takes slug-like tenant names", () => {
    expect(CreateTenantRequestSchema.safeParse({ name: "acme-prod" }).success).toBe(true);
    for (const name of ["", "Acme", "a b", "-x", "x/../y"]) {
      expect(CreateTenantRequestSchema.safeParse({ name }).success).toBe(false);
    }
  });
});
