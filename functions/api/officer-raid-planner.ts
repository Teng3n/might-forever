import {
  hasOfficerPasswordConfig,
  hasValidOfficerSession,
  jsonResponse,
  safeParseJson,
  type OfficerAuthEnv,
} from "../_shared/officer-auth";
import type { D1Database } from "../_shared/character-history";

interface RaidPlannerEnv extends OfficerAuthEnv {
  HISTORY_DB?: D1Database;
}

interface PagesContext {
  request: Request;
  env: RaidPlannerEnv;
}

type RaidRole = "Tank" | "Healer" | "Melee DPS" | "Ranged DPS";
type Subgroup = "A" | "B";
type RaidGroup = 1 | 2 | 3 | 4;

interface RaidAssignment {
  characterSlug: string;
  assignedRole: RaidRole;
  assignedSpec: string;
  offspecTank: boolean;
  offspecHealer: boolean;
  subgroup: Subgroup;
  raidGroup: RaidGroup;
}

interface RaidTeam {
  id: "team-a" | "team-b";
  name: string;
  locked: boolean;
  assignments: RaidAssignment[];
}

interface RaidPlan {
  teams: RaidTeam[];
}

interface PlanRow {
  version: number;
  plan_json: string;
  updated_at: string;
}

const allowedRoles = new Set<RaidRole>(["Tank", "Healer", "Melee DPS", "Ranged DPS"]);
const allowedTeamIds = new Set<RaidTeam["id"]>(["team-a", "team-b"]);
const allowedSubgroups = new Set<Subgroup>(["A", "B"]);
const allowedRaidGroups = new Set<RaidGroup>([1, 2, 3, 4]);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const emptyPlan = (): RaidPlan => ({
  teams: [
    { id: "team-a", name: "Raid Team A", locked: false, assignments: [] },
    { id: "team-b", name: "Raid Team B", locked: false, assignments: [] },
  ],
});

const parseAssignment = (value: unknown): RaidAssignment | null => {
  if (!value || typeof value !== "object") return null;

  const row = value as Record<string, unknown>;
  const characterSlug = typeof row.characterSlug === "string" ? row.characterSlug.trim().toLowerCase() : "";
  const assignedRole = row.assignedRole as RaidRole;
  const assignedSpec = typeof row.assignedSpec === "string" ? row.assignedSpec.trim().slice(0, 64) : "";
  const subgroup = row.subgroup as Subgroup;
  const requestedRaidGroup = typeof row.raidGroup === "number" ? row.raidGroup : 0;
  const raidGroup = allowedRaidGroups.has(requestedRaidGroup as RaidGroup)
    ? (requestedRaidGroup as RaidGroup)
    : subgroup === "B"
      ? 3
      : 1;

  if (
    !slugPattern.test(characterSlug) ||
    !allowedRoles.has(assignedRole) ||
    !assignedSpec ||
    !allowedSubgroups.has(subgroup)
  ) {
    return null;
  }

  return {
    characterSlug,
    assignedRole,
    assignedSpec,
    offspecTank: row.offspecTank === true,
    offspecHealer: row.offspecHealer === true,
    subgroup: raidGroup <= 2 ? "A" : "B",
    raidGroup,
  };
};

const parsePlan = (value: unknown): RaidPlan | null => {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).teams)) {
    return null;
  }

  const rawTeams = (value as { teams: unknown[] }).teams;

  if (rawTeams.length !== 2) return null;

  const teams: RaidTeam[] = [];
  const teamIds = new Set<string>();
  const assignedSlugs = new Set<string>();

  for (const value of rawTeams) {
    if (!value || typeof value !== "object") return null;

    const row = value as Record<string, unknown>;
    const id = row.id as RaidTeam["id"];
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 60) : "";
    const rawAssignments = Array.isArray(row.assignments) ? row.assignments : [];

    if (!allowedTeamIds.has(id) || teamIds.has(id) || !name || rawAssignments.length > 20) return null;

    const assignments: RaidAssignment[] = [];
    const groupCounts = new Map<RaidGroup, number>();

    for (const rawAssignment of rawAssignments) {
      const assignment = parseAssignment(rawAssignment);

      if (!assignment || assignedSlugs.has(assignment.characterSlug)) return null;

      const rawRaidGroup =
        rawAssignment && typeof rawAssignment === "object"
          ? (rawAssignment as Record<string, unknown>).raidGroup
          : undefined;
      if (!allowedRaidGroups.has(rawRaidGroup as RaidGroup)) {
        const compatibleGroups: RaidGroup[] = assignment.subgroup === "A" ? [1, 2] : [3, 4];
        assignment.raidGroup = compatibleGroups.find((group) => (groupCounts.get(group) ?? 0) < 5) ?? compatibleGroups[1];
        assignment.subgroup = assignment.raidGroup <= 2 ? "A" : "B";
      }

      assignedSlugs.add(assignment.characterSlug);
      const groupCount = (groupCounts.get(assignment.raidGroup) ?? 0) + 1;
      if (groupCount > 5) return null;
      groupCounts.set(assignment.raidGroup, groupCount);
      assignments.push(assignment);
    }

    teamIds.add(id);
    teams.push({ id, name, locked: row.locked === true, assignments });
  }

  return { teams: teams.sort((left, right) => left.id.localeCompare(right.id)) };
};

const readPlan = async (db: D1Database) => {
  const row = await db
    .prepare("SELECT version, plan_json, updated_at FROM officer_raid_plans WHERE id = ?")
    .bind("default")
    .first<PlanRow>();

  if (!row) {
    return { plan: emptyPlan(), version: 0, updatedAt: null };
  }

  try {
    return {
      plan: parsePlan(JSON.parse(row.plan_json)) ?? emptyPlan(),
      version: row.version,
      updatedAt: row.updated_at,
    };
  } catch {
    console.error("[officer-raid-planner] Saved plan JSON is invalid.");
    return { plan: emptyPlan(), version: row.version, updatedAt: row.updated_at };
  }
};

export const onRequest = async ({ request, env }: PagesContext) => {
  if (request.method !== "GET" && request.method !== "PUT") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET, PUT" });
  }

  if (!hasOfficerPasswordConfig(env)) {
    console.error("[officer-raid-planner] Officer authentication is not configured.");
    return jsonResponse({ ok: false, message: "Unable to load the raid planner." }, 500);
  }

  if (!(await hasValidOfficerSession(request, env))) {
    return jsonResponse({ ok: false, message: "Officer access required." }, 401);
  }

  if (!env.HISTORY_DB) {
    console.error("[officer-raid-planner] HISTORY_DB is not bound.");
    return jsonResponse({ ok: false, message: "Raid-plan storage is not connected." }, 503);
  }

  if (request.method === "GET") {
    const saved = await readPlan(env.HISTORY_DB);
    return jsonResponse({ ok: true, ...saved });
  }

  const body = await safeParseJson(request);

  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, message: "Invalid raid plan." }, 400);
  }

  const record = body as Record<string, unknown>;
  const expectedVersion = typeof record.version === "number" && Number.isInteger(record.version) ? record.version : -1;
  const plan = parsePlan(record.plan);

  if (expectedVersion < 0 || !plan) {
    return jsonResponse({ ok: false, message: "Invalid raid plan." }, 400);
  }

  const updatedAt = new Date().toISOString();
  const nextVersion = expectedVersion + 1;
  const result = await env.HISTORY_DB.prepare(
    `INSERT INTO officer_raid_plans (id, version, plan_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       plan_json = excluded.plan_json,
       updated_at = excluded.updated_at
     WHERE officer_raid_plans.version = ?`,
  )
    .bind("default", nextVersion, JSON.stringify(plan), updatedAt, expectedVersion)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    const latest = await readPlan(env.HISTORY_DB);
    return jsonResponse(
      {
        ok: false,
        message: "This plan changed in another session. Reload before saving again.",
        version: latest.version,
        updatedAt: latest.updatedAt,
      },
      409,
    );
  }

  return jsonResponse({ ok: true, plan, version: nextVersion, updatedAt });
};
