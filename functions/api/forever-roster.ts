import {
  ForeverApiError,
  getForeverRoster,
  type ForeverApiEnv,
  type ForeverRosterPayload,
} from "../_shared/forever-api";

interface PagesContext {
  request: Request;
  env: ForeverApiEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface CacheStorageWithDefault extends CacheStorage {
  default?: Cache;
}

const FRESH_CACHE_SECONDS = 30 * 60;
const STALE_CACHE_SECONDS = 24 * 60 * 60;
const BROWSER_CACHE_SECONDS = 5 * 60;
const CACHE_VERSION = "v3";

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": `public, max-age=${BROWSER_CACHE_SECONDS}, stale-while-revalidate=${FRESH_CACHE_SECONDS}`,
};

const jsonResponse = (body: Record<string, unknown> | ForeverRosterPayload, status = 200, headers: HeadersInit = {}) =>
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
  url.searchParams.set("cache", `forever-roster-${CACHE_VERSION}-${tier}`);
  return new Request(url.toString(), { method: "GET" });
};

const readCachedResponse = async (cache: Cache | undefined, key: Request) => {
  if (!cache) {
    return undefined;
  }

  try {
    return await cache.match(key);
  } catch (error) {
    console.warn("[forever-roster] Cache lookup failed.", {
      message: error instanceof Error ? error.message : "Unknown cache error",
    });
    return undefined;
  }
};

const writeCachedResponse = async (cache: Cache, key: Request, payload: ForeverRosterPayload, maxAge: number) => {
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
  await cache.put(key, response);
};

export const onRequest = async ({ request, env, waitUntil }: PagesContext) => {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, {
      Allow: "GET",
      "Cache-Control": "no-store",
    });
  }

  const cache = getDefaultCache();
  const freshKey = getCacheKey(request, "fresh");
  const staleKey = getCacheKey(request, "stale");
  const cached = await readCachedResponse(cache, freshKey);

  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("Cache-Control", responseHeaders["Cache-Control"]);
    response.headers.set("X-Might-Roster-Source", "edge-cache");
    return response;
  }

  try {
    const payload = await getForeverRoster(env);

    if (cache) {
      const cacheWrite = Promise.all([
        writeCachedResponse(cache, freshKey, payload, FRESH_CACHE_SECONDS),
        writeCachedResponse(cache, staleKey, payload, STALE_CACHE_SECONDS),
      ]).catch((error) => {
        console.warn("[forever-roster] Cache write failed.", {
          message: error instanceof Error ? error.message : "Unknown cache error",
        });
      });

      if (waitUntil) {
        waitUntil(cacheWrite);
      } else {
        await cacheWrite;
      }
    }

    return jsonResponse(payload, 200, { "X-Might-Roster-Source": "blizzard" });
  } catch (error) {
    const stale = await readCachedResponse(cache, staleKey);

    if (stale) {
      const response = new Response(stale.body, stale);
      response.headers.set("Cache-Control", "public, max-age=60");
      response.headers.set("Warning", '110 - "Response is stale"');
      response.headers.set("X-Might-Roster-Source", "stale-cache");
      return response;
    }

    const status = error instanceof ForeverApiError ? error.status : 502;
    const isNotConfigured = status === 503;

    console.error("[forever-roster] Unable to load Blizzard roster.", {
      message: error instanceof Error ? error.message : "Unknown error",
      status,
    });

    return jsonResponse(
      {
        ok: false,
        code: isNotConfigured ? "not_configured" : "upstream_unavailable",
        message: isNotConfigured
          ? "The live guild roster connection is being configured."
          : "The live guild roster is temporarily unavailable.",
      },
      status,
      { "Cache-Control": "no-store" },
    );
  }
};
