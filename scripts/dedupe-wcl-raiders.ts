import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "docs", "warcraft-logs-unique-raiders.md");
const outputPath = path.join(root, "docs", "warcraft-logs-deduped-people.md");

const source = await readFile(sourcePath, "utf8");
const characters = source
  .split(/\r?\n/u)
  .map((line) => line.match(/^\d+\.\s+(.+)$/u)?.[1]?.trim())
  .filter((name): name is string => Boolean(name));

if (characters.length === 0) {
  throw new Error(`No numbered character entries found in ${sourcePath}`);
}

const indexByExactName = new Map(characters.map((name, index) => [name, index]));
const parent = characters.map((_, index) => index);

function find(index: number): number {
  if (parent[index] !== index) parent[index] = find(parent[index]);
  return parent[index];
}

function union(left: number, right: number) {
  const leftRoot = find(left);
  const rightRoot = find(right);
  if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
}

function visualKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replaceAll("ø", "o")
    .replaceAll("ð", "d")
    .replaceAll("ł", "l")
    .replaceAll("æ", "ae")
    .replaceAll("œ", "oe")
    .replaceAll("ß", "ss");
}

function mergeNames(names: string[]) {
  const indexes = names
    .map((name) => indexByExactName.get(name))
    .filter((index): index is number => index !== undefined);
  for (let index = 1; index < indexes.length; index += 1) union(indexes[0], indexes[index]);
}

function mergeMatches(predicate: (name: string) => boolean) {
  mergeNames(characters.filter(predicate));
}

// Safest automatic merge: the same spelling with only accents or visually
// equivalent special letters changed.
const byVisualKey = new Map<string, number[]>();
characters.forEach((name, index) => {
  const key = visualKey(name);
  byVisualKey.set(key, [...(byVisualKey.get(key) ?? []), index]);
});
for (const indexes of byVisualKey.values()) {
  for (let index = 1; index < indexes.length; index += 1) union(indexes[0], indexes[index]);
}

// A literal "two" or "tres" suffix is treated as an alt only when the base
// character also exists in the archive.
for (const name of characters) {
  const key = visualKey(name);
  for (const suffix of ["two", "tres"]) {
    if (!key.endsWith(suffix)) continue;
    const baseKey = key.slice(0, -suffix.length);
    const base = byVisualKey.get(baseKey)?.[0];
    const alt = indexByExactName.get(name);
    if (base !== undefined && alt !== undefined) union(base, alt);
  }
}

// User-confirmed groups from the numbered source list.
mergeNames(["Kargen", "Karkan", "Karkant", "Karkonk", "Fakekarkan"]);
mergeNames(["Kuradeldk", "Kuradelh", "Kuradelm", "Kuradelmtwo"]);
mergeNames(["Leafea", "Leafealol"]);
mergeNames(["Lilgargussy", "Lilmcmussy"]);
mergeNames(["Mavadin", "Mavaman", "Mavdeath", "Mavdog", "Maverickdog", "Maverlock"]);
mergeNames(["Popsicles", "Popsiclës", "Pøpsicles"]);
mergeNames(["Tengen", "Tengenn", "Tenngenn"]);
mergeMatches((name) => visualKey(name).startsWith("stim"));
mergeMatches((name) => /^sti+ngr/u.test(visualKey(name)) || ["stiing", "stingg"].includes(visualKey(name)));

// Additional high-confidence alt/rename families. These require a strong shared
// stem, a clear typo, or a consistent class/number suffix. Similar-looking names
// without one of those signals remain separate.
const confidentFamilies: string[][] = [
  ["Arumai", "Aurumai"],
  ["Audïo", "Audionova", "Audiorampage", "Audiorekt", "Audiorektd"],
  ["Badpaw", "Badpawsture"],
  ["Boaz", "Boáz", "Boâz", "Boazwar", "Boazx"],
  ["Boboloni", "Boborino", "Boboroni"],
  ["Cabbage", "Cabbdk", "Cabbegh", "Cabbm", "Cabboom", "Cabbwl"],
  ["Cardinalcrzy", "Cardinlcrzy"],
  ["Chazknight", "Chazwazer"],
  ["Chérry", "Chérrytwo"],
  ["Dollabillsz", "Dollabillyal", "Dollabillzs"],
  ["Drchicken", "Drrchicken"],
  ["Ezeru", "Ezeruu"],
  ["Fêlo", "Fêllo"],
  ["Freddy", "Freddyp", "Freddypp", "Freddyw", "Fredfred"],
  ["Frisch", "Frischy", "Frischý", "Bigfrisch"],
  ["Ghstbear", "Ghstmarauder", "Ghstravager"],
  ["Grideekay", "Gridy", "Gridydots", "Gridypal", "Gridyy"],
  ["Hydrobirth", "Hydroheat", "Hydroseed"],
  ["Hekapoo", "Hekkapoo"],
  ["Jackdark", "Jackdarktres", "Jackdarktwo", "Jackiedark"],
  ["Juicyfruits", "Juicyfruitz"],
  ["Kahnlum", "Khanlum"],
  ["Leviathal", "Leviathall", "Levithon"],
  ["Luckeylock", "Luckylock", "Unluckylock"],
  ["Lurah", "Lurahh"],
  ["Mennydotz", "Mennyzmage", "Mennyzz"],
  ["Moxnix", "Moxxnixx"],
  ["Mòósnuckle", "Snuckle"],
  ["Nibadin", "Nibgen", "Nibi", "Nibidin", "Niblaine", "Niblainelock", "Niblayne", "Nibliz", "Niblood", "Nibow"],
  ["Rainarrow", "Rainbolt"],
  ["Rapongi", "Rappongi"],
  ["Shandfu", "Shandx", "Shandz", "Shandzbtw", "Shandze", "Shandzs", "Shandzy"],
  ["Slipinside", "Slipnslides"],
  ["Sprahj", "Spraj", "Sprajj"],
  ["Supergiagant", "Supergiant"],
  ["Tavik", "Tavikk"],
  ["Treebeard", "Treebeardtwo"],
  ["Zimone", "Zimshock", "Zimstrike", "Zimtwo", "Zimx"],
];
for (const family of confidentFamilies) mergeNames(family);

const groups = new Map<number, string[]>();
characters.forEach((name, index) => {
  const rootIndex = find(index);
  groups.set(rootIndex, [...(groups.get(rootIndex) ?? []), name]);
});

const preferredRepresentatives = new Map<string, string>([
  ["Kargen", "Karkan"],
  ["Mavadin", "Maverickdog"],
  ["Popsicles", "Popsicles"],
  ["Tengen", "Tengen"],
  ["Stimadin", "Stim"],
  ["Stiing", "Stingroy"],
]);

function representative(names: string[]) {
  for (const [member, preferred] of preferredRepresentatives) {
    if (names.includes(member)) return preferred;
  }
  return [...names].sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
}

const personGroups = [...groups.values()]
  .map((names) => ({
    names: [...names].sort((left, right) => left.localeCompare(right)),
    representative: representative(names),
  }))
  .sort((left, right) => left.representative.localeCompare(right.representative));

const mergedGroups = personGroups.filter((group) => group.names.length > 1);
const collapsedCharacters = characters.length - personGroups.length;

const lines = [
  "# Warcraft Logs Conservatively Deduplicated People",
  "",
  "Generated from `warcraft-logs-unique-raiders.md` on 2026-09-22.",
  "",
  `- Logged character names: ${characters.length}`,
  `- Conservative person groups: ${personGroups.length}`,
  `- Character aliases collapsed: ${collapsedCharacters}`,
  `- Multi-character groups: ${mergedGroups.length}`,
  "",
  "This is a best-effort identity estimate, not a fact supplied by Warcraft Logs. Exact appearances in uploaded reports are factual; the person-level merges are inferred. The pass merges accent/special-character variants, explicit `two`/`tres` suffixes, the user-confirmed families, and a limited set of strong shared-stem alt families. Uncertain similarities remain separate.",
  "",
  "Explicitly kept separate per user guidance: `Khalila` and `Khanlum`; `Lilmodel` and the `Lilgargussy`/`Lilmcmussy` person.",
  "",
  "## Person-level roster",
  "",
  ...personGroups.map((group, index) => {
    const aliases = group.names.length > 1 ? ` — characters: ${group.names.join(", ")}` : "";
    return `${index + 1}. **${group.representative}**${aliases}`;
  }),
  "",
  "## Merged groups only",
  "",
  ...mergedGroups.map((group) => `- **${group.representative}**: ${group.names.join(", ")}`),
  "",
];

await writeFile(outputPath, lines.join("\n"), "utf8");
console.log(`Wrote ${path.relative(root, outputPath)}`);
console.log(`Characters: ${characters.length}`);
console.log(`Conservative people: ${personGroups.length}`);
console.log(`Collapsed aliases: ${collapsedCharacters}`);
console.log(`Merged groups: ${mergedGroups.length}`);
