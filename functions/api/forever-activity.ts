import { readRecentGuildGearEvents, type D1Database } from "../_shared/character-history";
import {
  ForeverApiError,
  getForeverGuildActivity,
  type ForeverApiEnv,
  type ForeverGuildActivityEvent,
} from "../_shared/forever-api";

interface ActivityEnv extends ForeverApiEnv {
  HISTORY_DB?: D1Database;
}

interface PagesContext {
  request: Request;
  env: ActivityEnv;
}

const titleCaseSlug = (slug: string) =>
  slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");

export const onRequest = async ({ request, env }: PagesContext) => {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, message: "Method not allowed." }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", Allow: "GET", "Cache-Control": "no-store" },
    });
  }

  try {
    const [blizzard, gearEvents] = await Promise.all([
      getForeverGuildActivity(env),
      env.HISTORY_DB ? readRecentGuildGearEvents(env.HISTORY_DB, 24).catch(() => []) : Promise.resolve([]),
    ]);
    const gearActivity: ForeverGuildActivityEvent[] = gearEvents.map((event) => ({
      id: `gear-${event.id}`,
      type: "gear" as const,
      characterName: titleCaseSlug(event.characterSlug),
      characterSlug: event.characterSlug,
      title: `Gained ${event.itemName}`,
      detail: [
        event.itemLevel === null ? "" : `Item level ${event.itemLevel}`,
        event.slot.replaceAll("_", " ").toLocaleLowerCase(),
      ]
        .filter(Boolean)
        .join(" · "),
      occurredAt: event.occurredAt,
    }));
    const events = [...blizzard.events, ...gearActivity]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 24);

    return new Response(JSON.stringify({ ok: true, syncedAt: new Date().toISOString(), events }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=900",
      },
    });
  } catch (error) {
    const status = error instanceof ForeverApiError ? error.status : 502;
    console.error("[forever-activity] Unable to load activity.", error);
    return new Response(
      JSON.stringify({ ok: false, message: status === 503 ? "The Blizzard connection is not configured yet." : "Guild activity is temporarily unavailable." }),
      { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }
};
