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
  equippedItemLevel: number | null;
  averageItemLevel: number | null;
  specialization: string;
  role: string;
  profileUrl: string;
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
    levelCapProfileCount: number;
    averageItemLevel: number | null;
    classCount: number;
  };
  members: ForeverRosterMember[];
}

export interface ForeverCharacterItem {
  id: number;
  slot: string;
  slotLabel: string;
  name: string;
  itemLevel: number | null;
  quality: string;
  qualityLabel: string;
  iconUrl: string | null;
  enchantments: string[];
  setName: string | null;
}

export interface ForeverEquipmentSet {
  id: number | null;
  name: string;
  equippedCount: number;
  totalCount: number;
  equippedItems: string[];
  bonuses: Array<{
    requiredCount: number;
    description: string;
    active: boolean;
  }>;
}

export interface ForeverCharacterPayload {
  ok: true;
  syncedAt: string;
  character: {
    id: number;
    slug: string;
    name: string;
    firstName: string;
    surname: string;
    level: number;
    className: string;
    raceName: string;
    faction: string;
    guildName: string;
    specialization: string;
    role: string;
    achievementPoints: number;
    equippedItemLevel: number | null;
    averageItemLevel: number | null;
    lastLoginAt: string | null;
    profileUrl: string;
    armoryUrl: string;
  };
  media: {
    avatarUrl: string | null;
    renderUrl: string | null;
  };
  equipment: ForeverCharacterItem[];
  equipmentSets: ForeverEquipmentSet[];
  pvp: {
    honorableKills: number;
    rank: number;
    maps: Array<{
      name: string;
      played: number;
      won: number;
      lost: number;
    }>;
  };
  statistics: Array<{
    key: string;
    label: string;
    value: number;
  }>;
  reputations: Array<{
    id: number;
    name: string;
    standing: string;
    value: number;
    max: number;
    tier: number;
  }>;
}

const MANUAL_CHARACTER_SPECIALIZATIONS: Record<string, { specialization: string; role: string }> = {
  "bad-pawsture": { specialization: "Feral Combat", role: "Melee DPS" },
  "chonkars-winterbourne": { specialization: "Arms", role: "Melee DPS" },
  "morphling-shapeshifter": { specialization: "Feral Combat", role: "Melee DPS" },
};

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

const getLocalizedString = (value: unknown, locale: string) => {
  const direct = cleanString(value);

  if (direct) {
    return direct;
  }

  if (!isRecord(value)) {
    return "";
  }

  const requested = cleanString(value[locale]);

  if (requested) {
    return requested;
  }

  for (const candidate of Object.values(value)) {
    const localized = cleanString(candidate);

    if (localized) {
      return localized;
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

const fetchOptionalApiJson = async (url: URL, token: string, label: string) => {
  try {
    return await fetchApiJson(url, token, label);
  } catch (error) {
    console.warn(`[forever-api] Optional ${label} lookup failed.`, {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return {};
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

const getNestedRecord = (value: unknown, key: string) => {
  if (!isRecord(value)) {
    return null;
  }

  const nested = value[key];
  return isRecord(nested) ? nested : null;
};

const getNestedNumber = (value: unknown, key: string) => {
  const nested = getNestedRecord(value, key);
  return nested ? cleanNumber(nested.value) : null;
};

const getSafeBlizzardUrl = (value: unknown, region: string) => {
  const href = cleanString(value);

  if (!href) {
    return null;
  }

  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.hostname === `${region}.api.blizzard.com` ? url : null;
  } catch {
    return null;
  }
};

const getActiveSpecialization = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.specialization_groups)) {
    return "Unknown";
  }

  const activeGroup = value.specialization_groups.find(
    (group) => isRecord(group) && group.is_active === true && Array.isArray(group.specializations),
  );

  if (!isRecord(activeGroup) || !Array.isArray(activeGroup.specializations)) {
    return "Unknown";
  }

  let selectedName = "Unknown";
  let selectedPoints = -1;

  for (const entry of activeGroup.specializations) {
    if (!isRecord(entry)) {
      continue;
    }

    const name = cleanString(entry.specialization_name) || getReferenceName(entry.specialization, DEFAULT_LOCALE);
    const points = cleanNumber(entry.spent_points) ?? 0;

    if (name && points > selectedPoints) {
      selectedName = name;
      selectedPoints = points;
    }
  }

  return selectedName;
};

const getRole = (className: string, specialization: string) => {
  const classKey = className.toLowerCase();
  const specKey = specialization.toLowerCase();

  if (specKey.includes("protection") || specKey.includes("guardian")) {
    return "Tank";
  }

  if (specKey.includes("restoration") || specKey.includes("holy") || specKey.includes("discipline")) {
    return "Healer";
  }

  if (["mage", "warlock", "hunter"].includes(classKey) || specKey.includes("shadow") || specKey.includes("elemental") || specKey.includes("balance")) {
    return "Ranged DPS";
  }

  if (["warrior", "rogue", "paladin"].includes(classKey) || specKey.includes("feral") || specKey.includes("enhancement")) {
    return "Melee DPS";
  }

  return specialization === "Unknown" ? "Unknown" : "DPS";
};

const mapWithConcurrency = async <Input, Output>(
  values: Input[],
  limit: number,
  worker: (value: Input, index: number) => Promise<Output>,
) => {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(Math.max(limit, 1), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  });

  await Promise.all(runners);
  return results;
};

const getSession = async (env: ForeverApiEnv) => {
  const clientId = env.BLIZZARD_CLIENT_ID?.trim();
  const clientSecret = env.BLIZZARD_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new ForeverApiError("Blizzard API credentials are not configured.", 503);
  }

  const region = normalizeRegion(env.BLIZZARD_REGION);
  const locale = normalizeLocale(env.BLIZZARD_LOCALE);

  return {
    region,
    locale,
    guildSlug: normalizeGuildSlug(env.FOREVER_GUILD_SLUG),
    profileNamespace: `profile-forever-${region}`,
    staticNamespace: `static-forever-${region}`,
    token: await getAccessToken(clientId, clientSecret),
  };
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
      equippedItemLevel: null,
      averageItemLevel: null,
      specialization: "Unknown",
      role: "Unknown",
      profileUrl: `/roster/profile/${encodeURIComponent(slug)}`,
      armoryUrl: `${armoryBase}/character/${encodeURIComponent(slug)}/`,
    } satisfies ForeverRosterMember;
  });

  members.sort((left, right) => right.level - left.level || left.rank - right.rank || left.name.localeCompare(right.name));

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
      levelCapProfileCount: 0,
      averageItemLevel: null,
      classCount: new Set(members.map((member) => member.className).filter((name) => name !== "Unknown")).size,
    },
    members,
  };
};

export const getForeverRoster = async (env: ForeverApiEnv): Promise<ForeverRosterPayload> => {
  const { region, locale, guildSlug, profileNamespace, staticNamespace, token } = await getSession(env);

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

  const payload = normalizeForeverRoster({
    guildData,
    rosterData,
    classData,
    raceData,
    region,
    locale,
    guildSlug,
    rankNamesJson: env.FOREVER_GUILD_RANK_NAMES_JSON,
  });

  const levelCapMembers = payload.members.filter((member) => member.level >= LEVEL_CAP);
  const enriched = await mapWithConcurrency(levelCapMembers, 8, async (member) => {
    try {
      const profileData = await fetchApiJson(
        getApiUrl(region, locale, profileNamespace, `/profile/wow/character/${encodeURIComponent(member.slug)}`),
        token,
        `${member.name} profile`,
      );
      let specializationData: unknown = null;

      try {
        specializationData = await fetchApiJson(
          getApiUrl(
            region,
            locale,
            profileNamespace,
            `/profile/wow/character/${encodeURIComponent(member.slug)}/specializations`,
          ),
          token,
          `${member.name} specializations`,
        );
      } catch (error) {
        console.warn("[forever-api] Character specialization lookup failed.", {
          slug: member.slug,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }

      const profile = isRecord(profileData) ? profileData : {};
      const specialization = getActiveSpecialization(specializationData);
      return {
        member,
        equippedItemLevel: cleanNumber(profile.equipped_item_level),
        averageItemLevel: cleanNumber(profile.average_item_level),
        specialization,
        role: getRole(member.className, specialization),
      };
    } catch (error) {
      console.warn("[forever-api] Level 60 character profile lookup failed.", {
        slug: member.slug,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  });

  const itemLevels: number[] = [];

  for (const result of enriched) {
    if (!result) {
      continue;
    }

    result.member.equippedItemLevel = result.equippedItemLevel;
    result.member.averageItemLevel = result.averageItemLevel;
    result.member.specialization = result.specialization;
    result.member.role = result.role;

    if (result.equippedItemLevel !== null) {
      itemLevels.push(result.equippedItemLevel);
    }
  }

  for (const member of payload.members) {
    const manualSpecialization = MANUAL_CHARACTER_SPECIALIZATIONS[member.slug];

    if (manualSpecialization) {
      member.specialization = manualSpecialization.specialization;
      member.role = manualSpecialization.role;
    }
  }

  payload.summary.levelCapProfileCount = itemLevels.length;
  payload.summary.averageItemLevel = itemLevels.length
    ? Math.round((itemLevels.reduce((total, itemLevel) => total + itemLevel, 0) / itemLevels.length) * 10) / 10
    : null;

  return payload;
};

const getAsset = (value: unknown, keys: string[]) => {
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    return null;
  }

  for (const key of keys) {
    const asset = value.assets.find((entry) => isRecord(entry) && cleanString(entry.key) === key);

    if (isRecord(asset)) {
      const url = cleanString(asset.value);

      if (url.startsWith("https://")) {
        return url;
      }
    }
  }

  return null;
};

export const getForeverCharacter = async (env: ForeverApiEnv, requestedSlug: string): Promise<ForeverCharacterPayload> => {
  const slug = requestedSlug.trim().toLowerCase();

  if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
    throw new ForeverApiError("Character not found.", 404);
  }

  const { region, locale, profileNamespace, token } = await getSession(env);
  const path = `/profile/wow/character/${encodeURIComponent(slug)}`;
  const [profileData, equipmentData, mediaData, pvpData, reputationData, statisticsData, specializationData] =
    await Promise.all([
      fetchApiJson(getApiUrl(region, locale, profileNamespace, path), token, "character profile"),
      fetchApiJson(getApiUrl(region, locale, profileNamespace, `${path}/equipment`), token, "character equipment"),
      fetchOptionalApiJson(
        getApiUrl(region, locale, profileNamespace, `${path}/character-media`),
        token,
        "character media",
      ),
      fetchOptionalApiJson(
        getApiUrl(region, locale, profileNamespace, `${path}/pvp-summary`),
        token,
        "character PvP",
      ),
      fetchOptionalApiJson(
        getApiUrl(region, locale, profileNamespace, `${path}/reputations`),
        token,
        "character reputations",
      ),
      fetchOptionalApiJson(
        getApiUrl(region, locale, profileNamespace, `${path}/statistics`),
        token,
        "character statistics",
      ),
      fetchOptionalApiJson(
        getApiUrl(region, locale, profileNamespace, `${path}/specializations`),
        token,
        "character specializations",
      ),
    ]);

  if (
    !isRecord(profileData) ||
    !isRecord(equipmentData) ||
    !isRecord(mediaData) ||
    !isRecord(pvpData) ||
    !isRecord(reputationData) ||
    !isRecord(statisticsData)
  ) {
    throw new ForeverApiError("Blizzard returned an unsupported character response.");
  }

  const characterId = cleanNumber(profileData.id);
  const firstName = cleanString(profileData.name);
  const surname = cleanString(profileData.surname);
  const level = cleanNumber(profileData.level);
  const className = getReferenceName(profileData.character_class, locale) || "Unknown";
  const raceName = getReferenceName(profileData.race, locale) || "Unknown";

  if (characterId === null || !firstName || level === null) {
    throw new ForeverApiError("Blizzard returned an incomplete character profile.");
  }

  const equipmentRows = Array.isArray(equipmentData.equipped_items) ? equipmentData.equipped_items : [];
  const pendingItems = equipmentRows.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }

    const itemId = getReferenceId(value.item);
    const slot = getTypeName(value.slot);
    const name = cleanString(value.name);
    const media = getNestedRecord(value, "media");
    const mediaKey = getNestedRecord(media, "key");

    if (itemId === null || !slot || !name) {
      return [];
    }

    const enchantments = Array.isArray(value.enchantments)
      ? value.enchantments
          .map((enchantment) =>
            isRecord(enchantment)
              ? cleanString(enchantment.display_string) || getReferenceName(enchantment.source_item, locale)
              : "",
          )
          .filter(Boolean)
      : [];
    const set = getNestedRecord(value, "set");

    return [
      {
        id: itemId,
        slot,
        slotLabel: getReferenceName(value.slot, locale) || slot,
        name,
        itemLevel: getNestedNumber(value, "level"),
        quality: getTypeName(value.quality) || "UNKNOWN",
        qualityLabel: getReferenceName(value.quality, locale) || "Unknown",
        iconUrl: null,
        enchantments,
        setName: set ? getReferenceName(set.item_set, locale) || null : null,
        mediaUrl: getSafeBlizzardUrl(mediaKey?.href, region),
      },
    ];
  });

  const equipment = await mapWithConcurrency(pendingItems, 6, async (item) => {
    let iconUrl: string | null = null;

    if (item.mediaUrl) {
      try {
        iconUrl = getAsset(await fetchApiJson(item.mediaUrl, token, `${item.name} media`), ["icon"]);
      } catch (error) {
        console.warn("[forever-api] Item artwork lookup failed.", {
          itemId: item.id,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const { mediaUrl: _mediaUrl, ...publicItem } = item;
    return { ...publicItem, iconUrl } satisfies ForeverCharacterItem;
  });

  const topLevelSetRows = Array.isArray(equipmentData.equipped_item_sets)
    ? equipmentData.equipped_item_sets.filter(isRecord)
    : [];
  const itemSetRows = equipmentRows.flatMap((value) => {
    if (!isRecord(value) || !isRecord(value.set)) {
      return [];
    }

    return [value.set];
  });
  const equipmentSets = new Map<string, ForeverEquipmentSet>();

  for (const setRow of [...topLevelSetRows, ...itemSetRows]) {
    const setReference = isRecord(setRow.item_set) ? setRow.item_set : null;
    const setName = getReferenceName(setReference, locale);

    if (!setName) {
      continue;
    }

    const setId = getReferenceId(setReference);
    const setKey = setId === null ? setName.toLocaleLowerCase() : String(setId);

    if (equipmentSets.has(setKey)) {
      continue;
    }

    const setItems = Array.isArray(setRow.items) ? setRow.items.filter(isRecord) : [];
    const explicitlyEquippedItems = setItems.flatMap((setItem) => {
      if (setItem.is_equipped !== true) {
        return [];
      }

      const itemName = getReferenceName(setItem.item, locale);
      return itemName ? [itemName] : [];
    });
    const equippedItems = explicitlyEquippedItems.length
      ? explicitlyEquippedItems
      : equipment.filter((item) => item.setName === setName).map((item) => item.name);
    const uniqueEquippedItems = [...new Set(equippedItems)].sort((left, right) => left.localeCompare(right));
    const equippedCount = uniqueEquippedItems.length;
    const bonuses = (Array.isArray(setRow.effects) ? setRow.effects : [])
      .flatMap((effect) => {
        if (!isRecord(effect)) {
          return [];
        }

        const requiredCount = cleanNumber(effect.required_count);
        const rawDescription = getLocalizedString(effect.display_string, locale);

        if (requiredCount === null || !rawDescription) {
          return [];
        }

        const description = rawDescription.replace(/^\(\d+\)\s*Set:\s*/i, "").replace(/^Set:\s*/i, "");
        return [
          {
            requiredCount,
            description,
            active: effect.is_active === true || requiredCount <= equippedCount,
          },
        ];
      })
      .sort((left, right) => left.requiredCount - right.requiredCount);

    equipmentSets.set(setKey, {
      id: setId,
      name: setName,
      equippedCount,
      totalCount: Math.max(setItems.length, equippedCount),
      equippedItems: uniqueEquippedItems,
      bonuses,
    });
  }

  const manualSpecialization = MANUAL_CHARACTER_SPECIALIZATIONS[slug];
  const specialization = manualSpecialization?.specialization ?? getActiveSpecialization(specializationData);
  const lastLoginTimestamp = cleanNumber(profileData.last_login_timestamp);
  const lastLoginDate = lastLoginTimestamp ? new Date(lastLoginTimestamp) : null;
  const guildName = getReferenceName(profileData.guild, locale) || "Might";
  const characterName = [firstName, surname].filter(Boolean).join(" ");
  const armoryBase = `https://worldofwarcraft.blizzard.com/en-us/forever/${region}/armory`;
  const pvpMaps = Array.isArray(pvpData.pvp_map_statistics) ? pvpData.pvp_map_statistics : [];
  const reputations = Array.isArray(reputationData.reputations) ? reputationData.reputations : [];
  const statisticDefinitions = [
    ["health", "Health"],
    ["stamina", "Stamina"],
    ["strength", "Strength"],
    ["agility", "Agility"],
    ["intellect", "Intellect"],
    ["armor", "Armor"],
    ["attack_power", "Attack power"],
    ["spell_power", "Spell power"],
    ["melee_crit", "Melee crit"],
    ["spell_crit", "Spell crit"],
    ["melee_hit", "Melee hit"],
    ["spell_hit", "Spell hit"],
  ] as const;

  const statistics = statisticDefinitions.flatMap(([key, label]) => {
    const raw = statisticsData[key];
    const record = isRecord(raw) ? raw : null;
    const value =
      cleanNumber(raw) ??
      (record ? cleanNumber(record.value) ?? cleanNumber(record.rating) ?? cleanNumber(record.percent) : null);
    return value === null || value === 0 ? [] : [{ key, label, value }];
  });

  return {
    ok: true,
    syncedAt: new Date().toISOString(),
    character: {
      id: characterId,
      slug,
      name: characterName,
      firstName,
      surname,
      level,
      className,
      raceName,
      faction: getTypeName(profileData.faction) || "Alliance",
      guildName,
      specialization,
      role: manualSpecialization?.role ?? getRole(className, specialization),
      achievementPoints: cleanNumber(profileData.achievement_points) ?? 0,
      equippedItemLevel: cleanNumber(profileData.equipped_item_level),
      averageItemLevel: cleanNumber(profileData.average_item_level),
      lastLoginAt: lastLoginDate && !Number.isNaN(lastLoginDate.getTime()) ? lastLoginDate.toISOString() : null,
      profileUrl: `/roster/profile/${encodeURIComponent(slug)}`,
      armoryUrl: `${armoryBase}/character/${encodeURIComponent(slug)}/`,
    },
    media: {
      avatarUrl: getAsset(mediaData, ["avatar", "avatar-sd"]),
      renderUrl: getAsset(mediaData, ["main-raw", "main-sd-raw"]),
    },
    equipment,
    equipmentSets: [...equipmentSets.values()].sort((left, right) => left.name.localeCompare(right.name)),
    pvp: {
      honorableKills: cleanNumber(pvpData.honorable_kills) ?? 0,
      rank: cleanNumber(pvpData.pvp_rank) ?? 0,
      maps: pvpMaps.flatMap((entry) => {
        if (!isRecord(entry) || !isRecord(entry.match_statistics)) {
          return [];
        }

        const played = cleanNumber(entry.match_statistics.played) ?? 0;
        const won = cleanNumber(entry.match_statistics.won) ?? 0;
        const lost = cleanNumber(entry.match_statistics.lost) ?? 0;
        return [{ name: getReferenceName(entry.world_map, locale) || "Battleground", played, won, lost }];
      }),
    },
    statistics,
    reputations: reputations
      .flatMap((entry) => {
        if (!isRecord(entry) || !isRecord(entry.standing)) {
          return [];
        }

        const id = getReferenceId(entry.faction);
        const name = getReferenceName(entry.faction, locale);

        if (id === null || !name) {
          return [];
        }

        return [
          {
            id,
            name,
            standing: cleanString(entry.standing.name) || "Unknown",
            value: cleanNumber(entry.standing.value) ?? 0,
            max: cleanNumber(entry.standing.max) ?? 0,
            tier: cleanNumber(entry.standing.tier) ?? 0,
          },
        ];
      })
      .sort((left, right) => right.tier - left.tier || right.value - left.value || left.name.localeCompare(right.name)),
  };
};
