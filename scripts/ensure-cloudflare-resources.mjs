import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runtimeContract } from "./cloudflare-runtime-contract.mjs";

const requestTimeoutMs = 30_000;
const retryableRequestAttempts = 5;
let accountId;
let token;

if (isMainModule()) {
  await main(process.argv[2]);
}

export async function main(envName) {
  if (!["preview", "production"].includes(envName)) {
    fail("Usage: node scripts/ensure-cloudflare-resources.mjs <preview|production>");
  }

  accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  token = requiredEnv("CLOUDFLARE_API_TOKEN");
  const workersSubdomain = normalizeWorkersSubdomain(requiredEnv("CLOUDFLARE_DEV_WORKERS_SUBDOMAIN"));
  const resource = runtimeContract.resources[envName];
  const variablePrefix = deploymentVariablePrefix(envName);

  console.log(`Ensuring Cloudflare ${envName} resources...`);
  const d1 = await ensureD1Database(resource.d1DatabaseName);
  await ensureR2Bucket(resource.r2BucketName);
  const kv = await ensureKVNamespace(resource.kvNamespaceName);
  const queues = await listAll(`/accounts/${accountId}/queues`, "result");
  await ensureQueue(resource.emailQueueName, queues);
  await ensureQueue(resource.emailDeadLetterQueueName, queues);

  const workerUrl = `https://${resource.workerName}.${workersSubdomain}.workers.dev`;
  const variables = {
    [`${variablePrefix}_SITE_D1_DATABASE_ID`]: d1.uuid,
    [`${variablePrefix}_SITE_SESSION_KV_NAMESPACE_ID`]: kv.id,
    [`${variablePrefix}_SITE_URL`]: workerUrl,
  };

  for (const [name, value] of Object.entries(variables)) {
    setGithubEnv(name, value);
  }
  await persistGithubRepositoryVariables(variables);

  console.log(`Cloudflare ${envName} resources are ready.`);
  console.log(`Worker URL: ${workerUrl}`);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function deploymentVariablePrefix(envName) {
  return envName === "production" ? "PRODUCTION" : "PREVIEW";
}

async function ensureD1Database(name) {
  console.log(`Ensuring D1 database: ${name}`);
  const existing = await listAll(`/accounts/${accountId}/d1/database`, "result");
  const found = existing.find((database) => database.name === name);
  if (found) {
    console.log(`Found D1 database: ${name}`);
    return found;
  }

  const created = await cloudflare(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  console.log(`Created D1 database: ${name}`);
  return created.result;
}

async function ensureR2Bucket(name) {
  console.log(`Ensuring R2 bucket: ${name}`);
  const existing = await listAll(`/accounts/${accountId}/r2/buckets`, "result.buckets");
  const found = existing.find((bucket) => bucket.name === name);
  if (found) {
    console.log(`Found R2 bucket: ${name}`);
    return found;
  }

  const created = await cloudflare(
    `/accounts/${accountId}/r2/buckets/${name}`,
    { method: "PUT" },
    { allowOwnedR2BucketConflict: true },
  );
  if (created.alreadyExists) {
    console.log(`Found R2 bucket: ${name}`);
    return { name };
  }
  console.log(`Created R2 bucket: ${name}`);
  return created.result ?? { name };
}

async function ensureKVNamespace(title) {
  console.log(`Ensuring KV namespace: ${title}`);
  const existing = await listAll(`/accounts/${accountId}/storage/kv/namespaces`, "result");
  const found = existing.find((namespace) => namespace.title === title);
  if (found) {
    console.log(`Found KV namespace: ${title}`);
    return found;
  }

  const created = await cloudflare(`/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  console.log(`Created KV namespace: ${title}`);
  return created.result;
}

async function ensureQueue(name, existingQueues) {
  console.log(`Ensuring Queue: ${name}`);
  const found = existingQueues.find((queue) => queue.queue_name === name);
  if (found) {
    console.log(`Found Queue: ${name}`);
    return found;
  }

  const created = await cloudflare(`/accounts/${accountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: name }),
  });
  const queue = created.result ?? { queue_name: name };
  existingQueues.push(queue);
  console.log(`Created Queue: ${name}`);
  return queue;
}

async function listAll(path, resultPath) {
  const items = [];
  let page = 1;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await cloudflare(`${path}${separator}per_page=100&page=${page}`);
    const pageItems = getPath(response, resultPath);
    items.push(...pageItems);
    if (!hasNextCloudflarePage(response, pageItems.length)) break;
    page += 1;
  }
  return items;
}

export function hasNextCloudflarePage(response, itemCount) {
  const info = response.result_info;
  if (!info) return false;
  const page = Number(info.page ?? 1);
  if (Number.isFinite(info.total_pages)) return page < info.total_pages;
  if (Number.isFinite(info.total_count) && Number.isFinite(info.per_page)) {
    return page * info.per_page < info.total_count && itemCount >= info.per_page;
  }
  if (Number.isFinite(info.count) && Number.isFinite(info.per_page)) {
    return info.count >= info.per_page && itemCount >= info.per_page;
  }
  return false;
}

async function cloudflare(path, options = {}, errorOptions = {}) {
  for (let attempt = 1; attempt <= retryableRequestAttempts; attempt += 1) {
    try {
      return await cloudflareOnce(path, options, errorOptions);
    } catch (error) {
      if (!isRetryableRequestError(error) || attempt === retryableRequestAttempts) {
        fail(`Cloudflare API request failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const delayMs = Math.min(2_000 * attempt, 10_000);
      console.warn(
        `Cloudflare API request failed for ${path} on attempt ${attempt}/${retryableRequestAttempts}; retrying in ${delayMs}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sleep(delayMs);
    }
  }

  fail(`Cloudflare API request failed for ${path}`);
}

async function cloudflareOnce(path, options = {}, errorOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const response = await fetchWithTimeout(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  }).finally(() => clearTimeout(timeout));
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    if (errorOptions.allowOwnedR2BucketConflict && isOwnedR2BucketConflict(body, response.status)) {
      return { success: true, alreadyExists: true, result: null };
    }
    const message = body.errors?.map((error) => error.message).join("; ") || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function isOwnedR2BucketConflict(body, status = 0) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const messages = errors.map((error) => (typeof error?.message === "string" ? error.message : ""));
  const serialized = JSON.stringify(body ?? {});
  const text = [...messages, serialized].join(" ");
  const isBucketExists = /bucket[^.]*already exists|already exists[^.]*bucket/i.test(text);
  const isOwnedByAccount = /you own it|already own|owned by you/i.test(text);
  return isBucketExists && (isOwnedByAccount || status === 409);
}

async function fetchWithTimeout(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Request timed out after ${requestTimeoutMs}ms for ${new URL(url).pathname}`);
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  }
}

function isRetryableRequestError(error) {
  const status = Number(error?.status);
  if ([408, 409, 425, 429].includes(status)) return true;
  if (status >= 500 && status <= 599) return true;
  return status === 0 || !Number.isFinite(status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value) ?? [];
}

function setGithubEnv(name, value) {
  process.env[name] = value;
  if (!process.env.GITHUB_ENV) return;
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

async function persistGithubRepositoryVariables(variables) {
  const githubToken = process.env.GH_REPOSITORY_VARIABLES_TOKEN;
  if (!githubToken) {
    console.log("GH_REPOSITORY_VARIABLES_TOKEN is not set; skipping GitHub repository variable persistence.");
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    fail("GITHUB_REPOSITORY is required when GH_REPOSITORY_VARIABLES_TOKEN is set");
  }

  for (const [name, value] of Object.entries(variables)) {
    await upsertGithubRepositoryVariable(repository, githubToken, name, value);
  }
}

async function upsertGithubRepositoryVariable(repository, githubToken, name, value) {
  console.log(`Upserting GitHub repository variable: ${name}`);
  const path = `/repos/${repository}/actions/variables/${encodeURIComponent(name)}`;
  const existing = await github(path, { method: "GET" }, githubToken, { allowNotFound: true });
  if (existing.status === 404) {
    await github(
      `/repos/${repository}/actions/variables`,
      {
        method: "POST",
        body: JSON.stringify({ name, value }),
      },
      githubToken,
    );
    console.log(`Created GitHub repository variable: ${name}`);
    return;
  }

  await github(
    path,
    {
      method: "PATCH",
      body: JSON.stringify({ name, value }),
    },
    githubToken,
  );
  console.log(`Updated GitHub repository variable: ${name}`);
}

export async function github(path, options = {}, githubToken, behavior = {}, retryOptions = {}) {
  const attempts = retryOptions.attempts ?? retryableRequestAttempts;
  const sleepFn = retryOptions.sleepFn ?? sleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await githubOnce(path, options, githubToken, behavior);
    } catch (error) {
      if (!isRetryableRequestError(error) || attempt === attempts) {
        throw error;
      }
      const delayMs = Math.min(2_000 * attempt, 10_000);
      console.warn(
        `GitHub API request failed for ${path} on attempt ${attempt}/${attempts}; retrying in ${delayMs}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sleepFn(delayMs);
    }
  }

  throw new Error(`GitHub API request failed for ${path}`);
}

async function githubOnce(path, options = {}, githubToken, behavior = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    ...options,
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  }).finally(() => clearTimeout(timeout));

  if (response.status === 404 && behavior.allowNotFound) {
    return { status: 404 };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || response.statusText;
    const error = new Error(`GitHub API request failed for ${path}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return { status: response.status, body };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function normalizeWorkersSubdomain(value) {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.workers\.dev$/, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
