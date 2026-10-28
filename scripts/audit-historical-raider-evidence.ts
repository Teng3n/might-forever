import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

type CharacterAppearance = {
  expansion: string;
  className: string;
  lastDate: string;
  source: string;
  reportUrl: string;
  reportCode: string;
  reportTitle: string;
  fightId: number;
  encounterName: string;
};

type CharacterRecord = {
  name: string;
  appearances?: CharacterAppearance[];
};

type ReportActor = {
  id?: number | null;
  name?: string | null;
  type?: string | null;
  subType?: string | null;
};

type ReportEvidence = {
  code?: string | null;
  title?: string | null;
  masterData?: { actors?: ReportActor[] | null } | null;
  fights?: Array<{ id?: number | null; name?: string | null; friendlyPlayers?: number[] | null }> | null;
  playerDetails?: unknown;
  combatantInfo?: { data?: unknown; nextPageTimestamp?: number | null } | null;
};

type GraphQlResponse = {
  data?: { reportData?: { report?: ReportEvidence | null } | null };
  errors?: Array<{ message?: string }>;
};

type FightTarget = {
  reportCode: string;
  fightId: number;
  reportUrl: string;
  expected: Array<{ characterName: string; expansion: string; className: string }>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env") });

const sourcePath = path.join(root, "src", "data", "historicalRaiderCharacters.json");
const outputPath = path.join(root, "docs", "historical-raider-evidence-audit.json");
const endpoint = "https://classic.warcraftlogs.com/api/v2/user";
const accessToken = String(process.env.WCL_USER_ACCESS_TOKEN ?? "").trim();
const concurrency = Math.max(1, Math.min(Number(process.env.WCL_AUDIT_CONCURRENCY) || 2, 4));

if (!accessToken) {
  throw new Error(
    "WCL_USER_ACCESS_TOKEN is required. Archived reports must be queried through Warcraft Logs' user API with a subscribing user's OAuth token.",
  );
}

const evidenceQuery = `
query HistoricalRaiderEvidence($code: String!, $fightIDs: [Int]) {
  reportData {
    report(code: $code) {
      code
      title
      masterData(translate: true) {
        actors { id name type subType }
      }
      fights(fightIDs: $fightIDs, translate: true) {
        id
        name
        friendlyPlayers
      }
      playerDetails(fightIDs: $fightIDs, includeCombatantInfo: true)
      combatantInfo: events(dataType: CombatantInfo, fightIDs: $fightIDs, limit: 10000) {
        data
        nextPageTimestamp
      }
    }
  }
}
`;

const normalize = (value: unknown) => String(value ?? "").trim().normalize("NFC").toLocaleLowerCase();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

function collectPlayerNames(value: unknown, names = new Set<string>()): Set<string> {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectPlayerNames(item, names);
    return names;
  }
  if (!isRecord(parsed)) return names;

  for (const bucket of ["tanks", "healers", "dps", "players"]) {
    const entries = parsed[bucket];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.name === "string") names.add(normalize(entry.name));
    }
  }
  if ("data" in parsed) collectPlayerNames(parsed.data, names);
  if ("playerDetails" in parsed) collectPlayerNames(parsed.playerDetails, names);
  return names;
}

function collectCombatantIds(value: unknown, ids = new Set<number>()): Set<number> {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectCombatantIds(item, ids);
    return ids;
  }
  if (!isRecord(parsed)) return ids;

  const sourceId = Number(parsed.sourceID ?? parsed.sourceId);
  if (Number.isFinite(sourceId) && sourceId > 0) ids.add(sourceId);
  for (const item of Object.values(parsed)) collectCombatantIds(item, ids);
  return ids;
}

async function fetchEvidence(target: FightTarget, attempt = 1): Promise<ReportEvidence> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: evidenceQuery,
      variables: { code: target.reportCode, fightIDs: [target.fightId] },
    }),
  });
  const body = await response.text();

  if ((response.status === 429 || response.status >= 500) && attempt < 7) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60_000, 2_500 * 2 ** (attempt - 1));
    await new Promise((resolve) => setTimeout(resolve, delay));
    return fetchEvidence(target, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`${target.reportCode}:${target.fightId} returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const parsed = JSON.parse(body) as GraphQlResponse;
  if (parsed.errors?.length) {
    throw new Error(
      `${target.reportCode}:${target.fightId}: ${parsed.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ")}`,
    );
  }
  const report = parsed.data?.reportData?.report;
  if (!report) throw new Error(`${target.reportCode}:${target.fightId}: report was not returned.`);
  return report;
}

const characters = JSON.parse(await readFile(sourcePath, "utf8")) as CharacterRecord[];
const targetsByFight = new Map<string, FightTarget>();
for (const character of characters) {
  for (const appearance of character.appearances ?? []) {
    const key = `${appearance.reportCode}:${appearance.fightId}`;
    const target = targetsByFight.get(key) ?? {
      reportCode: appearance.reportCode,
      fightId: appearance.fightId,
      reportUrl: appearance.reportUrl,
      expected: [],
    };
    target.expected.push({
      characterName: character.name,
      expansion: appearance.expansion,
      className: appearance.className,
    });
    targetsByFight.set(key, target);
  }
}

const targets = [...targetsByFight.values()].sort(
  (left, right) => left.reportCode.localeCompare(right.reportCode) || left.fightId - right.fightId,
);
const results: unknown[] = new Array(targets.length);
let cursor = 0;
let completed = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= targets.length) return;
    const target = targets[index];

    try {
      const report = await fetchEvidence(target);
      const actors = report.masterData?.actors ?? [];
      const actorsByName = new Map<string, ReportActor[]>();
      for (const actor of actors) {
        const key = normalize(actor.name);
        if (key) actorsByName.set(key, [...(actorsByName.get(key) ?? []), actor]);
      }
      const fight = (report.fights ?? []).find((candidate) => Number(candidate.id) === target.fightId);
      const friendlyIds = new Set((fight?.friendlyPlayers ?? []).map(Number));
      const playerNames = collectPlayerNames(report.playerDetails);
      const combatantIds = collectCombatantIds(report.combatantInfo?.data);
      const evidence = target.expected.map((expected) => {
        const matchingActors = actorsByName.get(normalize(expected.characterName)) ?? [];
        const actorIds = matchingActors.map((actor) => Number(actor.id)).filter((id) => Number.isFinite(id));
        const inPlayerDetails = playerNames.has(normalize(expected.characterName));
        const hasCombatantInfo = actorIds.some((id) => combatantIds.has(id));
        const metadataFriendly = actorIds.some((id) => friendlyIds.has(id));

        return {
          ...expected,
          status: inPlayerDetails || hasCombatantInfo ? "verified" : metadataFriendly ? "metadata-only" : "missing",
          inPlayerDetails,
          hasCombatantInfo,
          metadataFriendly,
          actorIds,
        };
      });

      results[index] = {
        reportCode: target.reportCode,
        reportTitle: report.title ?? "",
        fightId: target.fightId,
        fightName: fight?.name ?? "",
        reportUrl: target.reportUrl,
        expectedCharacters: target.expected.length,
        playerDetailsCharacters: playerNames.size,
        combatantIds: combatantIds.size,
        evidence,
      };
    } catch (error) {
      results[index] = {
        reportCode: target.reportCode,
        fightId: target.fightId,
        reportUrl: target.reportUrl,
        expectedCharacters: target.expected.length,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    completed += 1;
    if (completed % 25 === 0 || completed === targets.length) {
      console.log(`Audited ${completed}/${targets.length} representative fights.`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const evidenceRows = results.flatMap((result) =>
  isRecord(result) && Array.isArray(result.evidence) ? result.evidence : [],
);
const summary = {
  generatedAt: new Date().toISOString(),
  characters: characters.length,
  representativeAppearances: evidenceRows.length,
  uniqueFights: targets.length,
  uniqueReports: new Set(targets.map((target) => target.reportCode)).size,
  verified: evidenceRows.filter((row) => isRecord(row) && row.status === "verified").length,
  metadataOnly: evidenceRows.filter((row) => isRecord(row) && row.status === "metadata-only").length,
  missing: evidenceRows.filter((row) => isRecord(row) && row.status === "missing").length,
  failedFights: results.filter((result) => isRecord(result) && typeof result.error === "string").length,
};

await writeFile(outputPath, `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
console.log(`EVIDENCE_AUDIT_SUMMARY ${JSON.stringify(summary)}`);
console.log(`Wrote ${path.relative(root, outputPath)}`);
