import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { google } from "googleapis";

type SheetRow = string[];
type AnswerCount = { label: string; count: number };
type RespondentLookup = Record<string, Record<string, string[]>>;

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
const surveyEncryptionKey = String(process.env.SURVEY_DATA_ENCRYPTION_KEY ?? "").trim();

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

const loadEncryptionKey = () => {
  if (!surveyEncryptionKey) {
    throw new Error("Missing SURVEY_DATA_ENCRYPTION_KEY.");
  }

  const key = Buffer.from(surveyEncryptionKey, "base64");

  if (key.length !== 32) {
    throw new Error("SURVEY_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }

  return key;
};

const loadCredentials = () => {
  if (!serviceAccountJson) {
    return undefined;
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

const collectRespondents = (
  rows: SheetRow[],
  usernameColumnIndex: number,
  definitions: Array<SeriesDefinition & { columnIndex: number }>,
): RespondentLookup => {
  const respondents: RespondentLookup = {};

  for (const definition of definitions) {
    const answers: Record<string, string[]> = {};

    for (const row of rows) {
      const username = clean(row[usernameColumnIndex]) || "Unknown respondent";
      const raw = clean(row[definition.columnIndex]);
      const values = definition.splitAnswers ? raw.split(",").map(clean).filter(Boolean) : raw ? [raw] : [];

      for (const value of values) {
        (answers[value] ??= []).push(username);
      }
    }

    respondents[definition.id] = answers;
  }

  return respondents;
};

const encryptPrivateSurveyData = (plaintext: string, key: Buffer) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);

  return {
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
};

async function main() {
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    ...(credentials ? { credentials } : {}),
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

  const resolvedDefinitions = seriesDefinitions.map((definition) => {
    const columnIndex = headers.indexOf(definition.header);

    if (columnIndex < 0) {
      throw new Error(`Survey response column not found: ${definition.header}`);
    }

    return { ...definition, columnIndex };
  });

  const series = resolvedDefinitions.map((definition) => ({
    id: definition.id,
    title: definition.title,
    answers: countAnswers(rows, definition.columnIndex, definition.splitAnswers),
  }));

  const usernameColumnIndex = headers.findIndex((header) => /discord username/i.test(header));

  if (usernameColumnIndex < 0) {
    throw new Error("Survey response column not found: Discord username");
  }

  const targetPath = path.join(root, "src/data/surveyInsights.json");
  const privateTargetPath = path.join(root, "src/data/surveyResponses.enc.json");
  const previousAggregateText = await fs.readFile(targetPath, "utf8").catch(() => "");
  const previousPrivateText = await fs.readFile(privateTargetPath, "utf8").catch(() => "");
  const lastResponseAt = clean(rows.at(-1)?.[0]);
  const aggregateCore = {
    responseCount: rows.length,
    lastResponseAt,
    source: {
      spreadsheetId,
      tabName: range.replace(/^'/, "").split("'")[0] || "Form Responses 1",
    },
    series,
  };

  let previousAggregate: Record<string, unknown> | undefined;

  try {
    previousAggregate = JSON.parse(previousAggregateText) as Record<string, unknown>;
  } catch {
    previousAggregate = undefined;
  }

  const previousCore = previousAggregate
    ? {
        responseCount: previousAggregate.responseCount,
        lastResponseAt: previousAggregate.lastResponseAt,
        source: previousAggregate.source,
        series: previousAggregate.series,
      }
    : undefined;
  const aggregateChanged = JSON.stringify(previousCore) !== JSON.stringify(aggregateCore);
  const generatedAt = aggregateChanged
    ? new Date().toISOString()
    : clean(previousAggregate?.generatedAt) || new Date().toISOString();

  const result = {
    generatedAt,
    ...aggregateCore,
  };

  const next = formatJson(result);

  if (previousAggregateText !== next) {
    await fs.writeFile(targetPath, next, "utf8");
    console.log(`Survey insights updated (${rows.length} responses).`);
  } else {
    console.log(`Survey insights unchanged (${rows.length} responses).`);
  }

  const questionHeaders = headers.slice(2).filter(Boolean);
  const people = rows.map((row, index) => ({
    id: `response-${index + 1}`,
    name: clean(row[usernameColumnIndex]) || "Unknown respondent",
    submittedAt: clean(row[0]),
    answers: questionHeaders.map((question) => ({
      question,
      answer: clean(row[headers.indexOf(question)]),
    })),
  }));
  const privateData = {
    version: 1,
    generatedAt,
    responseCount: rows.length,
    respondents: collectRespondents(rows, usernameColumnIndex, resolvedDefinitions),
    people,
  };
  const privatePlaintext = JSON.stringify(privateData);
  const encryptionKey = loadEncryptionKey();
  const contentHash = createHmac("sha256", encryptionKey).update(privatePlaintext).digest("hex");
  let previousPrivateHash = "";

  try {
    previousPrivateHash = clean((JSON.parse(previousPrivateText) as { contentHash?: string }).contentHash);
  } catch {
    previousPrivateHash = "";
  }

  if (contentHash !== previousPrivateHash) {
    const encrypted = encryptPrivateSurveyData(privatePlaintext, encryptionKey);
    const privateEnvelope = {
      version: 1,
      algorithm: "AES-256-GCM",
      generatedAt,
      responseCount: rows.length,
      source: aggregateCore.source,
      contentHash,
      ...encrypted,
    };

    await fs.writeFile(privateTargetPath, formatJson(privateEnvelope), "utf8");
    console.log(`Encrypted officer response data updated (${rows.length} responses).`);
  } else {
    console.log(`Encrypted officer response data unchanged (${rows.length} responses).`);
  }

  console.log("Public output contains aggregate counts only; individual responses remain encrypted.");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
