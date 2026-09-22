import roster from "../data/roster.json";
import { normalizePlayerName } from "./playerNames";

type RosterMember = {
  character: string;
  class: string;
};

export const classColors: Record<string, string> = {
  "Death Knight": "#c41e3a",
  Druid: "#ff7c0a",
  Hunter: "#aad372",
  Mage: "#3fc7eb",
  Monk: "#00ff98",
  Paladin: "#f48cba",
  Priest: "#ffffff",
  Rogue: "#fff468",
  Shaman: "#0070dd",
  Warlock: "#8788ee",
  Warrior: "#c69b6d",
};

const rosterMembers = roster as RosterMember[];
const rosterByName = new Map(rosterMembers.map((member) => [normalizePlayerName(member.character), member]));

export const getPlayerClass = (name: string) => rosterByName.get(normalizePlayerName(name))?.class;

export const getPlayerClassColor = (name: string) => {
  const className = getPlayerClass(name);
  return className ? classColors[className] : undefined;
};

export const getPlayerNameStyle = (name: string) => {
  const color = getPlayerClassColor(name);
  return color ? `--player-color: ${color}` : undefined;
};
