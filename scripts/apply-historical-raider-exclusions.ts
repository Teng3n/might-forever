import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Appearance = {
  source: string;
};

type CharacterRecord = {
  name: string;
  source: string;
  appearances?: Appearance[];
};

type ExclusionFile = {
  reviewedAt: string;
  reason: string;
  characters: string[];
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
const excludedNames = new Set(exclusions.characters.map((name) => name.normalize("NFC").toLocaleLowerCase()));
const retained = characters.filter((character) => !excludedNames.has(character.name.normalize("NFC").toLocaleLowerCase()));
const removed = characters.filter((character) => excludedNames.has(character.name.normalize("NFC").toLocaleLowerCase()));

if (removed.length === 0) {
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
if (removed.length > 0) console.log(`Removed: ${removed.map((character) => character.name).join(", ")}`);
