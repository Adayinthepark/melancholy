export const credentialProviders = [
  "openai",
  "anthropic",
  "deepseek",
  "kimi",
  "glm",
  "custom",
] as const;
export type CredentialProvider = (typeof credentialProviders)[number];
export const providerPresets: Record<
  CredentialProvider,
  { label: string; key: string; baseKey?: string; base?: string }
> = {
  openai: {
    label: "OpenAI compatible",
    key: "OPENAI_API_KEY",
    baseKey: "OPENAI_BASE_URL",
    base: "https://api.openai.com/v1",
  },
  anthropic: {
    label: "Anthropic compatible",
    key: "ANTHROPIC_API_KEY",
    baseKey: "ANTHROPIC_BASE_URL",
    base: "https://api.anthropic.com",
  },
  deepseek: {
    label: "DeepSeek",
    key: "DEEPSEEK_API_KEY",
    baseKey: "DEEPSEEK_BASE_URL",
    base: "https://api.deepseek.com",
  },
  kimi: {
    label: "Kimi",
    key: "MOONSHOT_API_KEY",
    baseKey: "MOONSHOT_BASE_URL",
    base: "https://api.moonshot.ai/v1",
  },
  glm: {
    label: "GLM",
    key: "ZHIPU_API_KEY",
    baseKey: "ZHIPU_BASE_URL",
    base: "https://open.bigmodel.cn/api/paas/v4",
  },
  custom: { label: "Custom credential", key: "" },
};
export { safeCredentialName } from "../packages/connector/environment-policy.mjs";
