const names: Record<string, string> = {
  anthropic: "Anthropic",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  fireworks: "Fireworks AI",
  google: "Google",
  groq: "Groq",
  mistral: "Mistral",
  openai: "OpenAI",
  opencode: "OpenCode Models",
  openrouter: "OpenRouter",
  together: "Together AI",
  xai: "xAI",
};

/** A provider's display name; its id when it has none. */
export const providerName = (id: string): string => names[id] ?? id;
