import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Appearance = {
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
  className: string;
  lastDate: string;
  source: string;
  reportUrl: string;
  reportCode: string;
  reportTitle: string;
  fightId: number;
  encounterName: string;
  appearances?: Appearance[];
};

type AppearanceExclusion = {
  characterName: string;
  reportCode: string;
  fightId: number;
};

type ExclusionFile = {
  reviewedAt: string;
  reason: string;
  characters: string[];
  appearances?: AppearanceExclusion[];
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const charactersPath = path.join(root, "src", "data", "historicalRaiderCharacters.json");
const exclusionsPath = path.join(root, "src", "data", "historicalRaiderExclusions.json");
const rosterPath = path.join(root, "docs", "warcraft-logs-unique-raiders.md");

const [characterSource, exclusionSource] = await Promise.all([
  readFile(charactersPath, "utf8"),
  readFile(exclusionsPath, "utf8"),
]);

const characters = JSON.parse(characterSource) as CharacterRecord[];
const exclusions = JSON.parse(exclusionSource) as ExclusionFile;
const normalizeName = (name: string) => name.normalize("NFC").toLocaleLowerCase();
const appearanceKey = (characterName: string, reportCode: string, fightId: number) =>
  `${normalizeName(characterName)}|${reportCode.toLocaleLowerCase()}|${fightId}`;
const excludedNames = new Set(exclusions.characters.map(normalizeName));
const excludedAppearances = new Set(
  (exclusions.appearances ?? []).map((appearance) =>
    appearanceKey(appearance.characterName, appearance.reportCode, appearance.fightId),
  ),
);
const removed: CharacterRecord[] = [];
const retained: CharacterRecord[] = [];
let prunedAppearanceCount = 0;

for (const character of characters) {
  if (excludedNames.has(normalizeName(character.name))) {
    removed.push(character);
    continue;
  }

  const appearances = character.appearances?.length
    ? character.appearances
    : [
        {
          expansion: "",
          className: character.className,
          lastDate: character.lastDate,
          source: character.source,
          reportUrl: character.reportUrl,
          reportCode: character.reportCode,
          reportTitle: character.reportTitle,
          fightId: character.fightId,
          encounterName: character.encounterName,
        },
      ];
  const keptAppearances = appearances.filter(
    (appearance) => !excludedAppearances.has(appearanceKey(character.name, appearance.reportCode, appearance.fightId)),
  );
  prunedAppearanceCount += appearances.length - keptAppearances.length;

  if (keptAppearances.length === 0) {
    removed.push(character);
    continue;
  }

  const sortedAppearances = [...keptAppearances].sort((left, right) => right.lastDate.localeCompare(left.lastDate));
  const latest = sortedAppearances[0];
  retained.push({
    ...character,
    className: latest.className,
    lastDate: latest.lastDate,
    source: latest.source,
    reportUrl: latest.reportUrl,
    reportCode: latest.reportCode,
    reportTitle: latest.reportTitle,
    fightId: latest.fightId,
    encounterName: latest.encounterName,
    appearances: sortedAppearances,
  });
}

if (removed.length === 0 && prunedAppearanceCount === 0) {
  console.log("No excluded historical-raider records were present.");
} else {
  await writeFile(charactersPath, `${JSON.stringify(retained, null, 2)}\n`, "utf8");
}

const sourceCounts = new Map<string, Set<string>>();
for (const character of retained) {
  const sources = new Set((character.appearances?.length ? character.appearances : [character]).map((appearance) => appearance.source));
  for (const source of sources) {
    sourceCounts.set(source, (sourceCounts.get(source) ?? new Set<string>()).add(character.name.toLocaleLowerCase()));
  }
}

const rosterLines = [
  "# Warcraft Logs Unique Raider Characters",
  "",
  `Generated from boss-fight attendance data; metadata-only records reviewed and excluded on ${exclusions.reviewedAt}.`,
  "",
  ...[...sourceCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, names]) => `- ${source}: ${names.size} character names`),
  `- Combined unique character names: ${retained.length}`,
  `- Metadata-only character names excluded: ${exclusions.characters.length}`,
  "",
  "Definition: a named player character with evidence supporting participation in an uploaded raid boss encounter where an approved guild-anchor character appeared in the same fight. A name appearing only in `friendlyPlayers` metadata, without class subtype, friendly spec, ranked-character, or equivalent participation evidence, is excluded.",
  "",
  "## Alphabetical list",
  "",
  ...retained
    .map((character) => character.name)
    .sort((left, right) => left.localeCompare(right))
    .map((name, index) => `${index + 1}. ${name}`),
  "",
];

await writeFile(rosterPath, rosterLines.join("\n"), "utf8");

console.log(`Historical raider records retained: ${retained.length}`);
console.log(`Historical raider records removed: ${removed.length}`);
console.log(`Excluded names absent from the input: ${exclusions.characters.length - removed.length}`);
console.log(`Metadata-only appearances pruned from retained characters: ${prunedAppearanceCount}`);
if (removed.length > 0) console.log(`Removed: ${removed.map((character) => character.name).join(", ")}`);
