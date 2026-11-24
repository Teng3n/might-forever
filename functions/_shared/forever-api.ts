export interface ForeverApiEnv {
  BLIZZARD_CLIENT_ID?: string;
  BLIZZARD_CLIENT_SECRET?: string;
  BLIZZARD_REGION?: string;
  BLIZZARD_LOCALE?: string;
  FOREVER_GUILD_SLUG?: string;
  FOREVER_GUILD_RANK_NAMES_JSON?: string;
}

export interface ForeverRosterMember {
  id: number;
  slug: string;
  name: string;
  firstName: string;
  surname: string;
  level: number;
  classId: number | null;
  className: string;
  raceId: number | null;
  raceName: string;
  faction: string;
  rank: number;
  rankLabel: string;
  armoryUrl: string;
}

export interface ForeverRosterPayload {
  ok: true;
  syncedAt: string;
  guild: {
    id: number | null;
    name: string;
    slug: string;
    faction: string;
    ruleset: string;
    memberCount: number;
    foundedAt: string | null;
    armoryUrl: string;
  };
  summary: {
    memberCount: number;
    levelCapCount: number;
    averageLevel: number;
    classCount: number;
  };
  members: ForeverRosterMember[];
}

type JsonRecord = Record<string, unknown>;

const TOKEN_TIMEOUT_MS = 10_000;
const API_TIMEOUT_MS = 15_000;
const DEFAULT_REGION = "us";
const DEFAULT_LOCALE = "en_US";
const DEFAULT_GUILD_SLUG = "might";
const MAX_ROSTER_SIZE = 2_000;
const LEVEL_CAP = 60;
// Blizzard's roster API uses zero-based rank indexes. The in-game guild UI labels these Rank 1–9.
const DEFAULT_GUILD_RANK_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0, "GM"],
  [1, "Officer"],
  [2, "Officer Alt"],
  [3, "Raider"],
  [4, "Raider Alt"],
  [5, "Member"],
  [6, "Trial"],
  [7, "Muted"],
  [8, "Friend"],
];

let tokenCache:
  | {
      clientId: string;
      token: string;
      expiresAt: number;
    }
  | undefined;
let pendingToken: Promise<string> | undefined;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cleanString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const cleanNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const getReferenceId = (value: unknown) => (isRecord(value) ? cleanNumber(value.id) : null);

const getReferenceName = (value: unknown, locale: string) => {
  if (typeof value === "string") {
    return value.trim();
  }

  if (!isRecord(value)) {
    return "";
  }

  const directName = cleanString(value.name);

  if (directName) {
    return directName;
  }

  const localizedName = value.name;

  if (isRecord(localizedName)) {
    const requested = cleanString(localizedName[locale]);

    if (requested) {
      return requested;
    }

    for (const candidate of Object.values(localizedName)) {
      const name = cleanString(candidate);

      if (name) {
        return name;
      }
    }
  }

  return "";
};

const getTypeName = (value: unknown) => {
  if (!isRecord(value)) {
    return "";
  }

  return cleanString(value.name) || cleanString(value.type);
};

const normalizeRegion = (value: string | undefined) => {
  const region = value?.trim().toLowerCase() || DEFAULT_REGION;
  return /^[a-z]{2}$/.test(region) ? region : DEFAULT_REGION;
};

const normalizeLocale = (value: string | undefined) => {
  const locale = value?.trim() || DEFAULT_LOCALE;
  return /^[a-z]{2}_[A-Z]{2}$/.test(locale) ? locale : DEFAULT_LOCALE;
};

const normalizeGuildSlug = (value: string | undefined) => {
  const slug = value?.trim().toLowerCase() || DEFAULT_GUILD_SLUG;
  return /^[a-z0-9%\-]+$/.test(slug) ? slug : DEFAULT_GUILD_SLUG;
};

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

export class ForeverApiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "ForeverApiError";
  }
}

const requestToken = async (clientId: string, clientSecret: string) => {
  const response = await fetchWithTimeout(
    "https://oauth.battle.net/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    },
    TOKEN_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new ForeverApiError("Blizzard authentication failed.", response.status === 401 ? 500 : 502);
  }

  const body = (await response.json()) as unknown;

  if (!isRecord(body)) {
    throw new ForeverApiError("Blizzard returned an invalid authentication response.");
  }

  const token = cleanString(body.access_token);
  const expiresIn = cleanNumber(body.expires_in);

  if (!token || !expiresIn || expiresIn <= 0) {
    throw new ForeverApiError("Blizzard returned an incomplete authentication response.");
  }

  tokenCache = {
    clientId,
    token,
    expiresAt: Date.now() + expiresIn * 1_000,
  };

  return token;
};

const getAccessToken = async (clientId: string, clientSecret: string) => {
  if (tokenCache?.clientId === clientId && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  if (!pendingToken) {
    pendingToken = requestToken(clientId, clientSecret).finally(() => {
      pendingToken = undefined;
    });
  }

  return pendingToken;
};

const fetchApiJson = async (url: URL, token: string, label: string) => {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    API_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new ForeverApiError(`Blizzard ${label} request failed.`, response.status === 404 ? 404 : 502);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ForeverApiError(`Blizzard ${label} response was not valid JSON.`);
  }
};

const getApiUrl = (region: string, locale: string, namespace: string, path: string) => {
  const url = new URL(`https://${region}.api.blizzard.com${path}`);
  url.searchParams.set("namespace", namespace);
  url.searchParams.set("locale", locale);
  return url;
};

const getIndexNames = (value: unknown, key: string, locale: string) => {
  const names = new Map<number, string>();

  if (!isRecord(value) || !Array.isArray(value[key])) {
    return names;
  }

  for (const entry of value[key]) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = cleanNumber(entry.id);
    const name = getReferenceName(entry, locale);

    if (id !== null && name) {
      names.set(id, name);
    }
  }

  return names;
};

const getRankNames = (value: string | undefined) => {
  const names = new Map<number, string>(DEFAULT_GUILD_RANK_NAMES);

  if (!value?.trim()) {
    return names;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!isRecord(parsed)) {
      return names;
    }

    for (const [rank, labelValue] of Object.entries(parsed)) {
      const rankNumber = Number(rank);
      const label = cleanString(labelValue);

      if (Number.isInteger(rankNumber) && rankNumber >= 0 && rankNumber <= 999 && label) {
        names.set(rankNumber, label);
      }
    }
  } catch {
    console.warn("[forever-api] FOREVER_GUILD_RANK_NAMES_JSON is invalid JSON; numeric ranks will be used.");
  }

  return names;
};

const getFoundedAt = (guild: JsonRecord) => {
  const timestamp = cleanNumber(guild.created_timestamp);

  if (!timestamp || timestamp <= 0) {
    return null;
  }

  const foundedAt = new Date(timestamp);
  return Number.isNaN(foundedAt.getTime()) ? null : foundedAt.toISOString();
};

interface NormalizeForeverRosterInput {
  guildData: unknown;
  rosterData: unknown;
  classData: unknown;
  raceData: unknown;
  region: string;
  locale: string;
  guildSlug: string;
  rankNamesJson?: string;
  syncedAt?: string;
}

export const normalizeForeverRoster = ({
  guildData,
  rosterData,
  classData,
  raceData,
  region,
  locale,
  guildSlug,
  rankNamesJson,
  syncedAt = new Date().toISOString(),
}: NormalizeForeverRosterInput): ForeverRosterPayload => {
  if (!isRecord(guildData) || !isRecord(rosterData) || !Array.isArray(rosterData.members)) {
    throw new ForeverApiError("Blizzard returned an unsupported guild roster response.");
  }

  if (rosterData.members.length > MAX_ROSTER_SIZE) {
    throw new ForeverApiError("Blizzard returned an unexpectedly large guild roster response.");
  }

  const classNames = getIndexNames(classData, "classes", locale);
  const raceNames = getIndexNames(raceData, "races", locale);
  const rankNames = getRankNames(rankNamesJson);
  const guildName = getReferenceName(guildData, locale) || "Might";
  const guildFaction = getTypeName(guildData.faction) || "Alliance";
  const guildRuleset = getReferenceName(guildData.ruleset, locale) || "PvP";
  const armoryBase = `https://worldofwarcraft.blizzard.com/en-us/forever/${region}/armory`;

  const members = rosterData.members.map((memberValue, index) => {
    if (!isRecord(memberValue) || !isRecord(memberValue.character)) {
      throw new ForeverApiError(`Blizzard guild roster member ${index + 1} has an unsupported shape.`);
    }

    const character = memberValue.character;
    const id = cleanNumber(character.id);
    const slug = cleanString(character.slug).toLowerCase();
    const firstName = cleanString(character.name);
    const surname = cleanString(character.surname);
    const level = cleanNumber(character.level);
    const rank = cleanNumber(memberValue.rank);
    const classId = getReferenceId(character.playable_class);
    const raceId = getReferenceId(character.playable_race);

    if (id === null || !slug || !firstName || level === null || rank === null) {
      throw new ForeverApiError(`Blizzard guild roster member ${index + 1} is missing required identity data.`);
    }

    return {
      id,
      slug,
      name: [firstName, surname].filter(Boolean).join(" "),
      firstName,
      surname,
      level,
      classId,
      className: classId === null ? "Unknown" : classNames.get(classId) || `Class ${classId}`,
      raceId,
      raceName: raceId === null ? "Unknown" : raceNames.get(raceId) || `Race ${raceId}`,
      faction: getTypeName(character.faction) || guildFaction,
      rank,
      rankLabel: rankNames.get(rank) || `Rank ${rank}`,
      armoryUrl: `${armoryBase}/character/${encodeURIComponent(slug)}/`,
    } satisfies ForeverRosterMember;
  });

  members.sort((left, right) => right.level - left.level || left.rank - right.rank || left.name.localeCompare(right.name));

  const averageLevel = members.length
    ? Math.round((members.reduce((total, member) => total + member.level, 0) / members.length) * 10) / 10
    : 0;

  return {
    ok: true,
    syncedAt,
    guild: {
      id: cleanNumber(guildData.id),
      name: guildName,
      slug: cleanString(guildData.slug) || guildSlug,
      faction: guildFaction,
      ruleset: guildRuleset,
      memberCount: members.length,
      foundedAt: getFoundedAt(guildData),
      armoryUrl: `${armoryBase}/guild/${encodeURIComponent(guildSlug)}`,
    },
    summary: {
      memberCount: members.length,
      levelCapCount: members.filter((member) => member.level >= LEVEL_CAP).length,
      averageLevel,
      classCount: new Set(members.map((member) => member.className).filter((name) => name !== "Unknown")).size,
    },
    members,
  };
};

export const getForeverRoster = async (env: ForeverApiEnv): Promise<ForeverRosterPayload> => {
  const clientId = env.BLIZZARD_CLIENT_ID?.trim();
  const clientSecret = env.BLIZZARD_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new ForeverApiError("Blizzard API credentials are not configured.", 503);
  }

  const region = normalizeRegion(env.BLIZZARD_REGION);
  const locale = normalizeLocale(env.BLIZZARD_LOCALE);
  const guildSlug = normalizeGuildSlug(env.FOREVER_GUILD_SLUG);
  const profileNamespace = `profile-forever-${region}`;
  const staticNamespace = `static-forever-${region}`;
  const token = await getAccessToken(clientId, clientSecret);

  const [guildData, rosterData, classData, raceData] = await Promise.all([
    fetchApiJson(
      getApiUrl(region, locale, profileNamespace, `/data/wow/guild/${encodeURIComponent(guildSlug)}`),
      token,
      "guild",
    ),
    fetchApiJson(
      getApiUrl(region, locale, profileNamespace, `/data/wow/guild/${encodeURIComponent(guildSlug)}/roster`),
      token,
      "guild roster",
    ),
    fetchApiJson(
      getApiUrl(region, locale, staticNamespace, "/data/wow/playable-class/index"),
      token,
      "class index",
    ),
    fetchApiJson(
      getApiUrl(region, locale, staticNamespace, "/data/wow/playable-race/index"),
      token,
      "race index",
    ),
  ]);

  return normalizeForeverRoster({
    guildData,
    rosterData,
    classData,
    raceData,
    region,
    locale,
    guildSlug,
    rankNamesJson: env.FOREVER_GUILD_RANK_NAMES_JSON,
  });
};
