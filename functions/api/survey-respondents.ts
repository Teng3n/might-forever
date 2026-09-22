import {
  hasOfficerPasswordConfig,
  hasValidOfficerSession,
  jsonResponse,
  type OfficerAuthEnv,
} from "../_shared/officer-auth";

interface SurveyRespondentsEnv extends OfficerAuthEnv {
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
    };
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

  const store = parseRespondentStore(env.SURVEY_RESPONDENTS_JSON ?? "");

  if (!store) {
    console.error("[survey-respondents] SURVEY_RESPONDENTS_JSON is missing or invalid.");
    return jsonResponse({ ok: false, message: "Respondent details are not configured." }, 503);
  }

  return jsonResponse({
    ok: true,
    responseCount: store.responseCount,
    respondents: store.respondents,
  });
};
