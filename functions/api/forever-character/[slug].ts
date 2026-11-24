import {
  recordCharacterSnapshot,
  unavailableCharacterHistory,
  type CharacterHistoryPayload,
  type D1Database,
} from "../../_shared/character-history";
import {
  ForeverApiError,
  getForeverCharacter,
  type ForeverApiEnv,
  type ForeverCharacterPayload,
} from "../../_shared/forever-api";

interface CharacterEnv extends ForeverApiEnv {
  HISTORY_DB?: D1Database;
}

interface PagesContext {
  request: Request;
  env: CharacterEnv;
  params: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface CacheStorageWithDefault extends CacheStorage {
  default?: Cache;
}

type CharacterResponse = ForeverCharacterPayload & {
  history: CharacterHistoryPayload;
};

const FRESH_CACHE_SECONDS = 15 * 60;
const STALE_CACHE_SECONDS = 24 * 60 * 60;
const BROWSER_CACHE_SECONDS = 5 * 60;
const CACHE_VERSION = "v4";

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": `public, max-age=${BROWSER_CACHE_SECONDS}, stale-while-revalidate=${FRESH_CACHE_SECONDS}`,
};

const jsonResponse = (body: Record<string, unknown> | CharacterResponse, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders,
      ...headers,
    },
  });

const getDefaultCache = () => (globalThis.caches as CacheStorageWithDefault | undefined)?.default;

const getCacheKey = (request: Request, tier: "fresh" | "stale") => {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("cache", `forever-character-${CACHE_VERSION}-${tier}`);
  return new Request(url.toString(), { method: "GET" });
};

const readCachedResponse = async (cache: Cache | undefined, key: Request) => {
  if (!cache) {
    return undefined;
  }

  try {
    return await cache.match(key);
  } catch {
    return undefined;
  }
};

const writeCachedResponse = async (cache: Cache, key: Request, payload: CharacterResponse, maxAge: number) => {
  await cache.put(
    key,
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${maxAge}`,
      },
    }),
  );
};

export const onRequest = async ({ request, env, params, waitUntil }: PagesContext) => {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, {
      Allow: "GET",
      "Cache-Control": "no-store",
    });
  }

  const rawSlug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const slug = rawSlug?.trim().toLowerCase() ?? "";

  if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
    return jsonResponse({ ok: false, message: "Character not found." }, 404, { "Cache-Control": "no-store" });
  }

  const cache = getDefaultCache();
  const freshKey = getCacheKey(request, "fresh");
  const staleKey = getCacheKey(request, "stale");
  const cached = await readCachedResponse(cache, freshKey);

  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("Cache-Control", responseHeaders["Cache-Control"]);
    response.headers.set("X-Might-Character-Source", "edge-cache");
    return response;
  }

  try {
    const character = await getForeverCharacter(env, slug);
    let history = unavailableCharacterHistory();

    if (env.HISTORY_DB) {
      try {
        history = await recordCharacterSnapshot(env.HISTORY_DB, character);
      } catch (error) {
        console.error("[forever-character] Unable to record character history.", {
          slug,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const payload: CharacterResponse = { ...character, history };

    if (cache) {
      const cacheWrite = Promise.all([
        writeCachedResponse(cache, freshKey, payload, FRESH_CACHE_SECONDS),
        writeCachedResponse(cache, staleKey, payload, STALE_CACHE_SECONDS),
      ]).catch((error) => {
        console.warn("[forever-character] Cache write failed.", {
          slug,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      });

      if (waitUntil) {
        waitUntil(cacheWrite);
      } else {
        await cacheWrite;
      }
    }

    return jsonResponse(payload, 200, { "X-Might-Character-Source": "blizzard" });
  } catch (error) {
    const stale = await readCachedResponse(cache, staleKey);

    if (stale) {
      const response = new Response(stale.body, stale);
      response.headers.set("Cache-Control", "public, max-age=60");
      response.headers.set("Warning", '110 - "Response is stale"');
      response.headers.set("X-Might-Character-Source", "stale-cache");
      return response;
    }

    const status = error instanceof ForeverApiError ? error.status : 502;
    const message =
      status === 404
        ? "That character is not available in Blizzard's WoW Forever profile API."
        : status === 503
          ? "The Blizzard connection is not configured yet."
          : "Blizzard character data is temporarily unavailable.";

    console.error("[forever-character] Unable to load character.", {
      slug,
      status,
      message: error instanceof Error ? error.message : "Unknown error",
    });

    return jsonResponse({ ok: false, message }, status, { "Cache-Control": "no-store" });
  }
};
