import {
  hasOfficerPasswordConfig,
  hasValidOfficerSession,
  jsonResponse,
  type OfficerAuthEnv,
} from "../_shared/officer-auth";
import encryptedSurveyResponses from "../../src/data/surveyResponses.enc.json";

interface SurveyRespondentsEnv extends OfficerAuthEnv {
  SURVEY_DATA_ENCRYPTION_KEY?: string;
  SURVEY_RESPONDENTS_JSON?: string;
}

interface PagesContext {
  request: Request;
  env: SurveyRespondentsEnv;
}

type RespondentStore = {
  version: number;
  responseCount: number;
  respondents: Record<string, Record<string, string[]>>;
  people?: SurveyPerson[];
};

type SurveyPerson = {
  id: string;
  name: string;
  submittedAt: string;
  answers: Array<{ question: string; answer: string }>;
};

type EncryptedSurveyEnvelope = {
  iv?: string;
  ciphertext?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRespondentStore = (value: string): RespondentStore | undefined => {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (!isRecord(parsed) || !isRecord(parsed.respondents)) {
      return undefined;
    }

    const respondents: Record<string, Record<string, string[]>> = {};

    for (const [seriesId, rawAnswers] of Object.entries(parsed.respondents)) {
      if (!isRecord(rawAnswers)) {
        return undefined;
      }

      const answers: Record<string, string[]> = {};

      for (const [answerLabel, rawNames] of Object.entries(rawAnswers)) {
        if (!Array.isArray(rawNames) || rawNames.some((name) => typeof name !== "string")) {
          return undefined;
        }

        answers[answerLabel] = rawNames;
      }

      respondents[seriesId] = answers;
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      responseCount: typeof parsed.responseCount === "number" ? parsed.responseCount : 0,
      respondents,
      people: Array.isArray(parsed.people)
        ? parsed.people.filter((person): person is SurveyPerson => {
            if (!isRecord(person) || !Array.isArray(person.answers)) {
              return false;
            }

            return (
              typeof person.id === "string" &&
              typeof person.name === "string" &&
              typeof person.submittedAt === "string" &&
              person.answers.every(
                (answer) =>
                  isRecord(answer) && typeof answer.question === "string" && typeof answer.answer === "string",
              )
            );
          })
        : [],
    };
  } catch {
    return undefined;
  }
};

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const decryptRespondentStore = async (keyValue: string): Promise<RespondentStore | undefined> => {
  const envelope = encryptedSurveyResponses as EncryptedSurveyEnvelope;

  if (!envelope.iv || !envelope.ciphertext) {
    return undefined;
  }

  try {
    const keyBytes = decodeBase64(keyValue);

    if (keyBytes.byteLength !== 32) {
      return undefined;
    }

    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(envelope.iv), tagLength: 128 },
      key,
      decodeBase64(envelope.ciphertext),
    );

    return parseRespondentStore(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
};

export const onRequest = async ({ request, env }: PagesContext) => {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET" });
  }

  if (!hasOfficerPasswordConfig(env)) {
    console.error("[survey-respondents] No officer password or password hash is configured.");
    return jsonResponse({ ok: false, message: "Unable to load respondent details." }, 500);
  }

  if (!(await hasValidOfficerSession(request, env))) {
    return jsonResponse({ ok: false, message: "Officer access required." }, 401);
  }

  const encryptedStore = env.SURVEY_DATA_ENCRYPTION_KEY
    ? await decryptRespondentStore(env.SURVEY_DATA_ENCRYPTION_KEY)
    : undefined;
  const store = encryptedStore ?? parseRespondentStore(env.SURVEY_RESPONDENTS_JSON ?? "");

  if (!store) {
    console.error("[survey-respondents] No valid encrypted or legacy respondent data is available.");
    return jsonResponse({ ok: false, message: "Respondent details are not configured." }, 503);
  }

  return jsonResponse({
    ok: true,
    responseCount: store.responseCount,
    respondents: store.respondents,
    people: store.people ?? [],
  });
};
