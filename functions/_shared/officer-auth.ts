export interface OfficerAuthEnv {
  SYNC_TRIGGER_PASSWORD?: string;
  SYNC_TRIGGER_PASSWORD_HASH?: string;
}

const OFFICER_SESSION_COOKIE = "might_forever_officer_session";
const OFFICER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

export const jsonResponse = (body: Record<string, unknown>, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

export const safeParseJson = async (request: Request) => {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
};

const timingSafeEqual = (actual: string, expected: string) => {
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  let diff = actualBytes.length ^ expectedBytes.length;
  const length = Math.max(actualBytes.length, expectedBytes.length);

  for (let index = 0; index < length; index += 1) {
    diff |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return diff === 0;
};

export const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hmacSha256Hex = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const getSessionSecret = async (env: OfficerAuthEnv) => {
  const expectedHash = env.SYNC_TRIGGER_PASSWORD_HASH?.trim().toLowerCase();

  if (expectedHash) {
    return expectedHash;
  }

  return env.SYNC_TRIGGER_PASSWORD ? sha256Hex(env.SYNC_TRIGGER_PASSWORD) : "";
};

export const hasOfficerPasswordConfig = (env: OfficerAuthEnv) =>
  Boolean(env.SYNC_TRIGGER_PASSWORD || env.SYNC_TRIGGER_PASSWORD_HASH);

export const isValidOfficerPassword = async (password: string, env: OfficerAuthEnv) => {
  const expectedHash = env.SYNC_TRIGGER_PASSWORD_HASH?.trim().toLowerCase();

  if (expectedHash) {
    return timingSafeEqual(await sha256Hex(password), expectedHash);
  }

  const expectedPassword = env.SYNC_TRIGGER_PASSWORD;
  return expectedPassword ? timingSafeEqual(password, expectedPassword) : false;
};

const getCookieValue = (request: Request, name: string) => {
  const cookieHeader = request.headers.get("Cookie");

  if (!cookieHeader) {
    return "";
  }

  for (const cookiePart of cookieHeader.split(";")) {
    const [cookieName, ...cookieValueParts] = cookiePart.trim().split("=");

    if (cookieName === name) {
      return cookieValueParts.join("=");
    }
  }

  return "";
};

export const createOfficerSessionCookie = async (env: OfficerAuthEnv) => {
  const expiresAt = Date.now() + OFFICER_SESSION_MAX_AGE_SECONDS * 1000;
  const payload = String(expiresAt);
  const signature = await hmacSha256Hex(payload, await getSessionSecret(env));
  const token = `${payload}.${signature}`;

  return `${OFFICER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
};

export const hasValidOfficerSession = async (request: Request, env: OfficerAuthEnv) => {
  const token = getCookieValue(request, OFFICER_SESSION_COOKIE);
  const [payload, signature] = token.split(".");
  const expiresAt = Number(payload);

  if (!payload || !signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return false;
  }

  const expectedSignature = await hmacSha256Hex(payload, await getSessionSecret(env));
  return timingSafeEqual(signature, expectedSignature);
};
