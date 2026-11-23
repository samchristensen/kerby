import { describe, expect, it } from "vitest";
import {
  DestinationConfigSchema,
  EVENT_TYPES,
  expandEventTypes,
  ListEventsQuerySchema,
} from "./index.ts";

describe("event type patterns", () => {
  it("expands a family wildcard to its types and * to every type, in catalog order", () => {
    expect(expandEventTypes(["turn.*"])).toEqual([
      "turn.started",
      "turn.completed",
      "turn.blocked",
      "turn.failed",
    ]);
    expect(expandEventTypes(["*"])).toEqual([...EVENT_TYPES]);
    expect(expandEventTypes(["judgment.failed", "conversation.*", "judgment.failed"])).toEqual([
      "conversation.created",
      "judgment.failed",
    ]);
    expect(expandEventTypes([])).toEqual([]);
  });
});

describe("GET /v1/events query", () => {
  it("parses comma-separated types and refuses an unknown one", () => {
    expect(ListEventsQuerySchema.parse({ types: "turn.*, message.created" })).toMatchObject({
      types: ["turn.*", "message.created"],
      limit: 100,
      wait: 0,
    });
    expect(ListEventsQuerySchema.safeParse({ types: "turn.*,turn.exploded" }).success).toBe(false);
    expect(ListEventsQuerySchema.safeParse({ types: "ping" }).success).toBe(false);
    expect(ListEventsQuerySchema.safeParse({ wait: "31" }).success).toBe(false);
    expect(ListEventsQuerySchema.safeParse({ after: "not-a-cursor" }).success).toBe(false);
    expect(ListEventsQuerySchema.parse({ after: "123.4", limit: "5" })).toMatchObject({
      after: "123.4",
      limit: 5,
    });
  });
});

describe("destinations", () => {
  const webhook = (url: string) => DestinationConfigSchema.safeParse({ kind: "webhook", url });

  it("accepts http(s) URLs only, without credentials in them", () => {
    expect(webhook("https://example.com/hooks/kerby").success).toBe(true);
    expect(webhook("http://localhost:3000/hook").success).toBe(true);
    expect(webhook("https://user:pass@example.com/hook").success).toBe(false);
    expect(webhook("https://user@example.com/hook").success).toBe(false);
    expect(webhook("ftp://example.com/hook").success).toBe(false);
    expect(webhook("javascript:alert(1)").success).toBe(false);
    expect(DestinationConfigSchema.safeParse({ kind: "email", url: "x" }).success).toBe(false);
  });
});
