import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CharacterRecord = {
  name: string;
  className: string;
  lastDate: string;
  source: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const groupsPath = path.join(root, "docs", "warcraft-logs-deduped-people.md");
const charactersPath = path.join(root, "src", "data", "historicalRaiderCharacters.json");
const outputPath = path.join(root, "src", "data", "historicalRaiders.json");

const classNames: Record<string, string> = {
  DeathKnight: "Death Knight",
  Druid: "Druid",
  Hunter: "Hunter",
  Mage: "Mage",
  Monk: "Monk",
  Paladin: "Paladin",
  Priest: "Priest",
  Rogue: "Rogue",
  Shaman: "Shaman",
  Warlock: "Warlock",
  Warrior: "Warrior",
  Unknown: "Unknown",
};

const classRoles: Record<string, string[]> = {
  "Death Knight": ["Tank", "DPS"],
  Druid: ["Tank", "Healer", "DPS"],
  Hunter: ["DPS"],
  Mage: ["DPS"],
  Monk: ["Tank", "Healer", "DPS"],
  Paladin: ["Tank", "Healer", "DPS"],
  Priest: ["Healer", "DPS"],
  Rogue: ["DPS"],
  Shaman: ["Healer", "DPS"],
  Warlock: ["DPS"],
  Warrior: ["Tank", "DPS"],
  Unknown: [],
};

const [groupsSource, characterSource] = await Promise.all([
  readFile(groupsPath, "utf8"),
  readFile(charactersPath, "utf8"),
]);

const characters = JSON.parse(characterSource) as CharacterRecord[];
const characterByName = new Map(characters.map((character) => [character.name, character]));
const rosterSection = groupsSource.split("## Person-level roster")[1]?.split("## Merged groups only")[0] ?? "";

const groups = rosterSection
  .split(/\r?\n/u)
  .map((line) => line.match(/^\d+\.\s+\*\*(.+?)\*\*(?:\s+— characters: (.+))?$/u))
  .filter((match): match is RegExpMatchArray => Boolean(match))
  .map((match) => ({
    name: match[1].trim(),
    characters: match[2]?.split(", ").map((name) => name.trim()) ?? [match[1].trim()],
  }));

const missing = groups.flatMap((group) => group.characters).filter((name) => !characterByName.has(name));
if (missing.length > 0) {
  throw new Error(`Missing attendance metadata for: ${missing.join(", ")}`);
}

const people = groups.map((group) => {
  const records = group.characters.map((name) => characterByName.get(name)!);
  const latest = [...records].sort((left, right) => right.lastDate.localeCompare(left.lastDate))[0];
  const observedClasses = [...new Set(records.map((record) => classNames[record.className] ?? "Unknown"))];
  const knownClasses = observedClasses.filter((className) => className !== "Unknown");
  const classes = (knownClasses.length > 0 ? knownClasses : observedClasses).sort((left, right) =>
    left.localeCompare(right),
  );
  const latestClass = classNames[latest.className] ?? "Unknown";
  const primaryClass = latestClass !== "Unknown" ? latestClass : classes[0] ?? "Unknown";
  const roles = [...new Set(classes.flatMap((className) => classRoles[className] ?? []))];

  return {
    name: group.name,
    characters: group.characters,
    characterDetails: records
      .map((record) => ({
        name: record.name,
        className: classNames[record.className] ?? "Unknown",
        lastDate: record.lastDate,
      }))
      .sort((left, right) => right.lastDate.localeCompare(left.lastDate)),
    classes,
    primaryClass,
    roles,
    lastDate: latest.lastDate,
    lastSource: latest.source,
    lastCharacter: latest.name,
  };
});

if (people.length !== 881) {
  throw new Error(`Expected 881 people, found ${people.length}`);
}

await writeFile(outputPath, `${JSON.stringify(people, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(root, outputPath)}`);
console.log(`People: ${people.length}`);
console.log(`Characters: ${characters.length}`);
