// The ids of the judgment providers a tenant can bring a key for, without the adapter code: the api and the console
// import this (`@kerby/judgment-systemone/providers`) to accept a key at `PUT /v1/model-keys/:provider`. `index.ts` maps
// each id to its endpoint; the type of that map keeps the two equal.
//
// `opencode` is also a chat provider (the Pi adapter's list): a tenant stores one OpenCode Console key and it serves both.
export const JUDGMENT_PROVIDERS = ["typesafe", "opencode"] as const;

export type JudgmentProviderId = (typeof JUDGMENT_PROVIDERS)[number];
