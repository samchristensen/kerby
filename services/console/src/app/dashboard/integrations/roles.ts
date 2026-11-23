import type { IntegrationRole } from "@kerby/contracts";

/** What each role means, in one sentence, wherever a person chooses one. */
export const ROLES: { role: IntegrationRole; label: string; hint: string }[] = [
  {
    role: "admin",
    label: "Admin",
    hint: "Its keys may do everything the API offers: conversations, judgments, prompts, model keys, and every tool.",
  },
  {
    role: "restricted",
    label: "Restricted",
    hint: "Its keys may only run conversations and judgments, with just the tools granted to it.",
  },
];
