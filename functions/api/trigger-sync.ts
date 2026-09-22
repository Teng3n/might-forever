import {
  hasOfficerPasswordConfig,
  hasValidOfficerSession,
  isValidOfficerPassword,
  jsonResponse,
  safeParseJson,
  type OfficerAuthEnv,
} from "../_shared/officer-auth";

interface Env extends OfficerAuthEnv {
  GITHUB_ACTIONS_DISPATCH_TOKEN?: string;
}

interface PagesContext {
  request: Request;
  env: Env;
}

type SyncType = "sheets" | "wcl" | "all";

const SYNC_WORKFLOWS: Record<SyncType, { workflowFile: string; successMessage: string }> = {
  sheets: {
    workflowFile: "sync-data.yml",
    successMessage: "Guild data sync workflow triggered.",
  },
  wcl: {
    workflowFile: "sync-wcl.yml",
    successMessage: "Warcraft Logs sync workflow triggered.",
  },
  all: {
    workflowFile: "sync-all.yml",
    successMessage: "Full sync workflow triggered.",
  },
};
const GITHUB_WORKFLOW_DISPATCH_BASE_URL = "https://api.github.com/repos/Teng3n/might-forever/actions/workflows";
const WORKFLOW_REF = "might-forever";
const COOLDOWN_MS = 60_000;
const SYNC_ERROR_MESSAGE = "Unable to trigger sync workflow.";

const lastTriggerAtByType = new Map<SyncType, number>();

const getSyncType = (body: unknown): SyncType | null => {
  if (!body || typeof body !== "object" || !("syncType" in body)) {
    return "sheets";
  }

  const syncType = String((body as { syncType?: unknown }).syncType ?? "").trim().toLowerCase();

  return syncType === "sheets" || syncType === "wcl" || syncType === "all" ? syncType : null;
};

const logGitHubDispatchFailure = (status: number, body: string) => {
  console.error("[trigger-sync] GitHub workflow dispatch failed.", {
    status,
    body,
  });

  if (status === 401 || status === 403) {
    console.error("[trigger-sync] GitHub dispatch failure is likely a token permission issue.");
  }

  if (status === 404) {
    console.error("[trigger-sync] GitHub dispatch failure is likely a repo, workflow filename, or branch/ref issue.");
  }
};

export const onRequest = async ({ request, env }: PagesContext) => {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, { Allow: "POST" });
  }

  if (!env.GITHUB_ACTIONS_DISPATCH_TOKEN) {
    console.error("[trigger-sync] GITHUB_ACTIONS_DISPATCH_TOKEN is not configured.");
    return jsonResponse({ ok: false, message: SYNC_ERROR_MESSAGE }, 500);
  }

  if (!hasOfficerPasswordConfig(env)) {
    console.error("[trigger-sync] No sync trigger password or password hash is configured.");
    return jsonResponse({ ok: false, message: SYNC_ERROR_MESSAGE }, 500);
  }

  const body = await safeParseJson(request);
  const syncType = getSyncType(body);

  if (!syncType) {
    return jsonResponse({ ok: false, message: "Invalid sync type." }, 400);
  }

  const workflow = SYNC_WORKFLOWS[syncType];
  const password =
    body && typeof body === "object" && "password" in body && typeof body.password === "string"
      ? body.password
      : "";

  const hasValidPassword = password ? await isValidOfficerPassword(password, env as OfficerAuthEnv) : false;
  const hasValidSession = hasValidPassword ? false : await hasValidOfficerSession(request, env as OfficerAuthEnv);

  if (!hasValidPassword && !hasValidSession) {
    return jsonResponse({ ok: false, message: "Invalid password." }, 401);
  }

  const now = Date.now();
  const lastTriggerAt = lastTriggerAtByType.get(syncType) ?? 0;

  if (now - lastTriggerAt < COOLDOWN_MS) {
    return jsonResponse({ ok: false, message: "Sync was triggered recently. Try again shortly." }, 429);
  }

  let githubResponse: Response;

  try {
    githubResponse = await fetch(`${GITHUB_WORKFLOW_DISPATCH_BASE_URL}/${workflow.workflowFile}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_ACTIONS_DISPATCH_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "might-forever-pages-function",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: WORKFLOW_REF }),
    });
  } catch (error) {
    console.error("[trigger-sync] GitHub workflow dispatch request failed before a response was received.", {
      message: error instanceof Error ? error.message : "Unknown fetch error",
    });
    return jsonResponse({ ok: false, message: SYNC_ERROR_MESSAGE }, 502);
  }

  console.info("[trigger-sync] GitHub workflow dispatch response status.", {
    status: githubResponse.status,
    syncType,
    workflow: workflow.workflowFile,
  });

  if (githubResponse.status !== 204) {
    logGitHubDispatchFailure(githubResponse.status, await githubResponse.text());
    return jsonResponse({ ok: false, message: SYNC_ERROR_MESSAGE }, 502);
  }

  console.info("[trigger-sync] GitHub workflow dispatch returned 204.");

  lastTriggerAtByType.set(syncType, Date.now());

  console.info("[trigger-sync] Returning successful sync trigger response.");

  return jsonResponse({ ok: true, message: workflow.successMessage });
};
