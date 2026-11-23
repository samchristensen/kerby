// Searching the tenant's chats and choosing the embedding model that makes the search semantic (ADR 0021). Both go
// through the api with the person's session token, like the chats themselves (ADR 0014). The query travels only in a
// POST body: never in a URL the console, the api or a proxy would log.
import {
  PutSearchSettingsRequestSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SearchSettingsSchema,
} from "@kerby/contracts";
import { listModelKeys } from "@kerby/control-plane";
import { SUGGESTED_EMBEDDING_MODELS } from "@kerby/embeddings-openai/providers";
import { z } from "zod";
import type {
  ChatAccess,
  ChatSearchView,
  ConsoleDeps,
  FormFailure,
  FormInput,
  SearchSettingsView,
} from "../types/index.ts";
import { apiError, apiFault } from "./api.ts";
import { parseForm, refuse } from "./forms.ts";

/** The hits one search shows: one per conversation, best first. */
const HITS_PER_SEARCH = 20;

const SearchForm = z.object({
  query: z
    .string()
    .trim()
    .min(1, "type something to search for")
    .max(1000, "at most 1 000 characters"),
});

const SettingsForm = z.object({
  /** Blank turns semantic search off. */
  embeddingModel: z.string().trim().max(200, "at most 200 characters").default(""),
});

export function createSearch(deps: ConsoleDeps) {
  const { api, control } = deps;

  return {
    async searchChats(
      access: ChatAccess,
      form: FormInput,
    ): Promise<{ ok: true; result: ChatSearchView } | FormFailure> {
      const parsed = parseForm(SearchForm, form);
      if (!parsed.ok) return parsed;
      const response = await api({
        method: "POST",
        path: "/v1/search",
        token: access.token,
        body: SearchRequestSchema.parse({ query: parsed.data.query, limit: HITS_PER_SEARCH }),
      });
      if (!response.ok) {
        const { code, message } = await apiError(response);
        if (code === "rate_limited") return refuse("Too many searches. Try again in a moment.");
        if (code === "invalid_request") return refuse(message ?? "The search was refused.");
        throw apiFault("search", response.status, code);
      }
      const { hits, mode, notice } = SearchResponseSchema.parse(await response.json());
      return {
        ok: true,
        result: {
          mode,
          notice,
          hits: hits.map((hit) => ({
            conversationId: hit.conversationId,
            seq: hit.seq,
            role: hit.role,
            title: hit.title,
            snippet: hit.snippet,
            createdAt: hit.createdAt,
          })),
        },
      };
    },

    async searchSettings(access: ChatAccess): Promise<SearchSettingsView> {
      const response = await api({
        method: "GET",
        path: "/v1/search/settings",
        token: access.token,
      });
      if (!response.ok) {
        throw apiFault("search settings", response.status, (await apiError(response)).code);
      }
      const settings = SearchSettingsSchema.parse(await response.json());
      const keys = new Set(
        (await listModelKeys(control, access.session.tenantId)).map((key) => key.provider),
      );
      return {
        ...settings,
        suggestions: Object.entries(SUGGESTED_EMBEDDING_MODELS).map(([provider, model]) => ({
          provider,
          model,
          configured: keys.has(provider),
        })),
      };
    },

    async setEmbeddingModel(
      access: ChatAccess,
      form: FormInput,
    ): Promise<{ ok: true; embeddingModel: string | null } | FormFailure> {
      const parsed = parseForm(SettingsForm, form);
      if (!parsed.ok) return parsed;
      const response = await api({
        method: "PUT",
        path: "/v1/search/settings",
        token: access.token,
        body: PutSearchSettingsRequestSchema.parse({
          embeddingModel: parsed.data.embeddingModel || null,
        }),
      });
      if (!response.ok) {
        const { code, message } = await apiError(response);
        switch (code) {
          case "invalid_model":
          case "invalid_request":
            return {
              ok: false,
              fields: { embeddingModel: message ?? "This model cannot be used for search." },
            };
          case "rate_limited":
            return refuse("Too many requests. Try again in a moment.");
        }
        throw apiFault("search settings", response.status, code);
      }
      const { embeddingModel } = SearchSettingsSchema.parse(await response.json());
      return { ok: true, embeddingModel };
    },
  };
}
