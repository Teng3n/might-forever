import {
  ForeverApiError,
  getForeverCraftingDirectory,
  type ForeverApiEnv,
  type ForeverCraftingPayload,
} from "../_shared/forever-api";

interface PagesContext {
  request: Request;
  env: ForeverApiEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface CacheStorageWithDefault extends CacheStorage {
  default?: Cache;
}

const FRESH_CACHE_SECONDS = 6 * 60 * 60;
const STALE_CACHE_SECONDS = 24 * 60 * 60;
const BROWSER_CACHE_SECONDS = 15 * 60;
const CACHE_VERSION = "v1";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": `public, max-age=${BROWSER_CACHE_SECONDS}, stale-while-revalidate=${FRESH_CACHE_SECONDS}`,
};

const jsonResponse = (body: Record<string, unknown> | ForeverCraftingPayload, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });

const getDefaultCache = () => (globalThis.caches as CacheStorageWithDefault | undefined)?.default;

const getCacheKey = (request: Request, tier: "fresh" | "stale") => {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("cache", `forever-crafting-${CACHE_VERSION}-${tier}`);
  return new Request(url.toString(), { method: "GET" });
};

const writeCache = async (cache: Cache, key: Request, payload: ForeverCraftingPayload, maxAge: number) => {
  await cache.put(
    key,
    new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
    }),
  );
};

export const onRequest = async ({ request, env, waitUntil }: PagesContext) => {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET", "Cache-Control": "no-store" });
  }

  const cache = getDefaultCache();
  const freshKey = getCacheKey(request, "fresh");
  const staleKey = getCacheKey(request, "stale");
  const cached = cache ? await cache.match(freshKey) : undefined;

  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("Cache-Control", headers["Cache-Control"]);
    response.headers.set("X-Might-Crafting-Source", "edge-cache");
    return response;
  }

  try {
    const payload = await getForeverCraftingDirectory(env);

    if (cache) {
      const cacheWrite = Promise.all([
        writeCache(cache, freshKey, payload, FRESH_CACHE_SECONDS),
        writeCache(cache, staleKey, payload, STALE_CACHE_SECONDS),
      ]).catch((error) => console.warn("[forever-crafting] Cache write failed.", error));

      if (waitUntil) waitUntil(cacheWrite);
      else await cacheWrite;
    }

    return jsonResponse(payload, 200, { "X-Might-Crafting-Source": "blizzard" });
  } catch (error) {
    const stale = cache ? await cache.match(staleKey) : undefined;

    if (stale) {
      const response = new Response(stale.body, stale);
      response.headers.set("Cache-Control", "public, max-age=60");
      response.headers.set("Warning", '110 - "Response is stale"');
      response.headers.set("X-Might-Crafting-Source", "stale-cache");
      return response;
    }

    const status = error instanceof ForeverApiError ? error.status : 502;
    console.error("[forever-crafting] Unable to load crafting directory.", error);
    return jsonResponse(
      { ok: false, message: status === 503 ? "The Blizzard connection is not configured yet." : "Crafting data is temporarily unavailable." },
      status,
      { "Cache-Control": "no-store" },
    );
  }
};
