import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { google } from "googleapis";

type SheetRow = string[];
type AnswerCount = { label: string; count: number };

type SeriesDefinition = {
  id: string;
  title: string;
  header: string;
  splitAnswers?: boolean;
};

type ServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env.local"), override: false });
loadEnv({ path: path.join(root, ".env"), override: false });

const spreadsheetId = String(
  process.env.SURVEY_SHEET_ID ?? "1EuKIShP55UUqlD0H3Ho_n00W9vaYnHcGMcdzDH9AcGw",
).trim();
const range = String(process.env.SURVEY_RESPONSES_RANGE ?? "'Form Responses 1'!A:M").trim();
const serviceAccountJson = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();

const seriesDefinitions: SeriesDefinition[] = [
  {
    id: "launchParticipation",
    title: "Expected launch participation",
    header: "How do you expect to participate in WoW Forever at launch?",
  },
  {
    id: "serverPreference",
    title: "Server preference",
    header: "Which server would you prefer the guild to play on?",
  },
  {
    id: "serverFlexibility",
    title: "Would follow to a different server",
    header: "If the guild selects a different server, would you still play with the guild?",
  },
  {
    id: "factionPreference",
    title: "Faction preference",
    header: "Which faction would you prefer?",
  },
  {
    id: "factionFlexibility",
    title: "Would follow to a different faction",
    header: "If the guild selects a different faction, would you still play with the guild?",
  },
  {
    id: "classInterest",
    title: "Likely main class",
    header: "Which class are you most likely to play as your main character?",
  },
  {
    id: "rolePreference",
    title: "Preferred raid role",
    header: "Which role would you prefer to fill in raids?",
  },
  {
    id: "alternateCharacters",
    title: "Raid-ready alternate characters",
    header: "Do you plan to maintain raid-ready alternate characters?",
  },
  {
    id: "professions",
    title: "Profession interest",
    header: "Which professions are you considering for your main character? Select up to two.",
    splitAnswers: true,
  },
  {
    id: "raidInterest",
    title: "Interested in raiding",
    header: "Would you like to raid with the guild in WoW Forever?",
  },
];

const clean = (value: unknown) => String(value ?? "").trim();
const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const loadCredentials = () => {
  if (!serviceAccountJson) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  }

  const credentials = JSON.parse(serviceAccountJson) as ServiceAccountCredentials;
  credentials.private_key = clean(credentials.private_key).replace(/\\n/g, "\n");

  if (!clean(credentials.client_email) || !clean(credentials.private_key)) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  }

  return credentials;
};

const countAnswers = (rows: SheetRow[], columnIndex: number, splitAnswers = false): AnswerCount[] => {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const raw = clean(row[columnIndex]);
    const answers = splitAnswers ? raw.split(",").map(clean).filter(Boolean) : raw ? [raw] : [];

    for (const answer of answers) {
      counts.set(answer, (counts.get(answer) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (response.data.values ?? []).map((row) => row.map(clean));
  const headers = values[0] ?? [];
  const rows = values.slice(1).filter((row) => row.some(Boolean));

  if (rows.length === 0) {
    throw new Error("The survey response sheet contains no response rows.");
  }

  const series = seriesDefinitions.map((definition) => {
    const columnIndex = headers.indexOf(definition.header);

    if (columnIndex < 0) {
      throw new Error(`Survey response column not found: ${definition.header}`);
    }

    return {
      id: definition.id,
      title: definition.title,
      answers: countAnswers(rows, columnIndex, definition.splitAnswers),
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    responseCount: rows.length,
    lastResponseAt: clean(rows.at(-1)?.[0]),
    source: {
      spreadsheetId,
      tabName: range.replace(/^'/, "").split("'")[0] || "Form Responses 1",
    },
    series,
  };

  const targetPath = path.join(root, "src/data/surveyInsights.json");
  const next = formatJson(result);
  const previous = await fs.readFile(targetPath, "utf8").catch(() => "");

  if (previous === next) {
    console.log(`Survey insights unchanged (${rows.length} responses).`);
    return;
  }

  await fs.writeFile(targetPath, next, "utf8");
  console.log(`Survey insights updated (${rows.length} responses).`);
  console.log("Only aggregate counts were written; usernames and free-text answers were excluded.");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
