import { getRuntimeConfigValue } from "../runtime-config.ts";

type RuntimeEnv = Record<string, unknown> & {
  DB?: {
    prepare: (sql: string) => {
      bind: (...values: unknown[]) => unknown;
      all?: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
    };
  };
};

const normalizePosthogHost = (value: string) => {
  const candidate = value.trim() || "https://us.i.posthog.com";

  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "https://us.i.posthog.com";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://us.i.posthog.com";
  }
};

export const getPublicPosthogConfig = async (env: RuntimeEnv) => {
  const projectApiKey = await getRuntimeConfigValue(env, "POSTHOG_PROJECT_API_KEY");
  const configuredHost = await getRuntimeConfigValue(env, "POSTHOG_HOST");

  return {
    enabled: projectApiKey.length > 0,
    projectApiKey,
    host: normalizePosthogHost(configuredHost),
  };
};
