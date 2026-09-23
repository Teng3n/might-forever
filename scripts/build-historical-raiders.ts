import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CharacterRecord = {
  name: string;
  className: string;
  lastDate: string;
  source: string;
  reportUrl?: string;
  reportCode?: string;
  reportTitle?: string;
  fightId?: number;
  encounterName?: string;
  appearances?: CharacterAppearance[];
};

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

const expansionOrder = ["Classic", "TBC", "Wrath", "Cataclysm", "MoP"];

const getExpansion = (date: string) => {
  if (date < "2021-06-01") return "Classic";
  if (date < "2022-09-26") return "TBC";
  if (date < "2024-05-20") return "Wrath";
  if (date < "2025-07-21") return "Cataclysm";
  return "MoP";
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
  const appearancesByCharacter = records.map((record) => ({
    record,
    appearances:
      record.appearances?.length
        ? record.appearances
        : [
            {
              expansion: getExpansion(record.lastDate),
              className: record.className,
              lastDate: record.lastDate,
              source: record.source,
              reportUrl: record.reportUrl ?? "",
              reportCode: record.reportCode ?? "",
              reportTitle: record.reportTitle ?? "",
              fightId: record.fightId ?? 0,
              encounterName: record.encounterName ?? "Raid encounter",
            },
          ],
  }));
  const allAppearances = appearancesByCharacter.flatMap(({ appearances }) => appearances);
  const observedClasses = [...new Set(allAppearances.map((appearance) => classNames[appearance.className] ?? "Unknown"))];
  const knownClasses = observedClasses.filter((className) => className !== "Unknown");
  const classes = (knownClasses.length > 0 ? knownClasses : observedClasses).sort((left, right) =>
    left.localeCompare(right),
  );
  const latestClass = classNames[latest.className] ?? "Unknown";
  const primaryClass = latestClass !== "Unknown" ? latestClass : classes[0] ?? "Unknown";
  const expansions = [...new Set(allAppearances.map((appearance) => appearance.expansion))].sort(
    (left, right) => expansionOrder.indexOf(left) - expansionOrder.indexOf(right),
  );

  return {
    name: group.name,
    characters: group.characters,
    characterDetails: appearancesByCharacter
      .map(({ record, appearances }) => ({
        name: record.name,
        className: classNames[record.className] ?? "Unknown",
        lastDate: record.lastDate,
        expansion: getExpansion(record.lastDate),
        source: record.source,
        reportUrl: record.reportUrl ?? "",
        reportTitle: record.reportTitle ?? "",
        encounterName: record.encounterName ?? "Raid encounter",
        appearances: appearances
          .map((appearance) => ({
            ...appearance,
            className: classNames[appearance.className] ?? "Unknown",
          }))
          .sort((left, right) => right.lastDate.localeCompare(left.lastDate)),
      }))
      .sort((left, right) => right.lastDate.localeCompare(left.lastDate)),
    classes,
    primaryClass,
    expansions,
    lastDate: latest.lastDate,
    lastSource: latest.source,
    lastCharacter: latest.name,
    lastReportUrl: latest.reportUrl ?? "",
    lastReportTitle: latest.reportTitle ?? "",
    lastEncounterName: latest.encounterName ?? "Raid encounter",
  };
});

await writeFile(outputPath, `${JSON.stringify(people, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(root, outputPath)}`);
console.log(`People: ${people.length}`);
console.log(`Characters: ${characters.length}`);
