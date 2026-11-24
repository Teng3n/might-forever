import type { ForeverCharacterItem, ForeverCharacterPayload } from "./forever-api";

interface D1ResultMeta {
  last_row_id?: number;
}

interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: D1ResultMeta;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
}

export interface CharacterHistoryPayload {
  available: boolean;
  baselineAt: string | null;
  latestSnapshotAt: string | null;
  snapshotCount: number;
  snapshots: Array<{
    capturedAt: string;
    equippedItemLevel: number | null;
    averageItemLevel: number | null;
    honorableKills: number;
  }>;
  events: Array<{
    id: number;
    type: "GAINED";
    itemId: number;
    itemName: string;
    itemLevel: number | null;
    quality: string;
    slot: string;
    occurredAt: string;
  }>;
}

interface SnapshotRow {
  id: number;
  captured_at: string;
  gear_hash: string;
  equipped_item_level: number | null;
  average_item_level: number | null;
  honorable_kills: number;
  is_baseline: number;
}

interface EventRow {
  id: number;
  event_type: "GAINED";
  item_id: number;
  item_name: string;
  item_level: number | null;
  quality: string;
  slot_type: string;
  occurred_at: string;
}

const buildGearHash = (items: ForeverCharacterItem[]) =>
  items
    .map((item) => `${item.slot}:${item.id}:${item.itemLevel ?? ""}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");

const insertSnapshot = async (
  db: D1Database,
  payload: ForeverCharacterPayload,
  gearHash: string,
  isBaseline: boolean,
) => {
  const row = await db
    .prepare(
      `INSERT INTO character_snapshots (
        character_id,
        character_slug,
        captured_at,
        gear_hash,
        equipped_item_level,
        average_item_level,
        honorable_kills,
        is_baseline,
        gear_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    )
    .bind(
      payload.character.id,
      payload.character.slug,
      payload.syncedAt,
      gearHash,
      payload.character.equippedItemLevel,
      payload.character.averageItemLevel,
      payload.pvp.honorableKills,
      isBaseline ? 1 : 0,
      JSON.stringify(payload.equipment),
    )
    .first<{ id: number }>();

  if (!row?.id) {
    throw new Error("Unable to create a character snapshot.");
  }

  return row.id;
};

const insertFirstSeenItems = async (
  db: D1Database,
  payload: ForeverCharacterPayload,
  snapshotId: number,
  items: ForeverCharacterItem[],
  isBaseline: boolean,
) => {
  if (!items.length) {
    return;
  }

  const statements: D1PreparedStatement[] = [];

  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO character_items (
            character_id,
            item_id,
            first_seen_at,
            first_snapshot_id,
            first_seen_as_baseline,
            item_name,
            item_level,
            quality,
            slot_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          payload.character.id,
          item.id,
          payload.syncedAt,
          snapshotId,
          isBaseline ? 1 : 0,
          item.name,
          item.itemLevel,
          item.quality,
          item.slot,
        ),
    );

    if (!isBaseline) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO character_gear_events (
              character_id,
              character_slug,
              event_type,
              item_id,
              item_name,
              item_level,
              quality,
              slot_type,
              occurred_at,
              snapshot_id
            ) VALUES (?, ?, 'GAINED', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            payload.character.id,
            payload.character.slug,
            item.id,
            item.name,
            item.itemLevel,
            item.quality,
            item.slot,
            payload.syncedAt,
            snapshotId,
          ),
      );
    }
  }

  await db.batch(statements);
};

const readHistory = async (db: D1Database, characterId: number): Promise<CharacterHistoryPayload> => {
  const [summary, snapshotResult, eventResult] = await Promise.all([
    db
      .prepare(
        `SELECT
          MIN(captured_at) AS baseline_at,
          MAX(captured_at) AS latest_snapshot_at,
          COUNT(*) AS snapshot_count
        FROM character_snapshots
        WHERE character_id = ?`,
      )
      .bind(characterId)
      .first<{ baseline_at: string | null; latest_snapshot_at: string | null; snapshot_count: number }>(),
    db
      .prepare(
        `SELECT
          captured_at,
          equipped_item_level,
          average_item_level,
          honorable_kills
        FROM character_snapshots
        WHERE character_id = ?
        ORDER BY captured_at ASC, id ASC
        LIMIT 60`,
      )
      .bind(characterId)
      .all<SnapshotRow>(),
    db
      .prepare(
        `SELECT
          id,
          event_type,
          item_id,
          item_name,
          item_level,
          quality,
          slot_type,
          occurred_at
        FROM character_gear_events
        WHERE character_id = ?
        ORDER BY occurred_at DESC, id DESC
        LIMIT 50`,
      )
      .bind(characterId)
      .all<EventRow>(),
  ]);

  return {
    available: true,
    baselineAt: summary?.baseline_at ?? null,
    latestSnapshotAt: summary?.latest_snapshot_at ?? null,
    snapshotCount: Number(summary?.snapshot_count ?? 0),
    snapshots: (snapshotResult.results ?? []).map((snapshot) => ({
      capturedAt: snapshot.captured_at,
      equippedItemLevel: snapshot.equipped_item_level,
      averageItemLevel: snapshot.average_item_level,
      honorableKills: snapshot.honorable_kills,
    })),
    events: (eventResult.results ?? []).map((event) => ({
      id: event.id,
      type: event.event_type,
      itemId: event.item_id,
      itemName: event.item_name,
      itemLevel: event.item_level,
      quality: event.quality,
      slot: event.slot_type,
      occurredAt: event.occurred_at,
    })),
  };
};

export const recordCharacterSnapshot = async (
  db: D1Database,
  payload: ForeverCharacterPayload,
): Promise<CharacterHistoryPayload> => {
  const latest = await db
    .prepare(
      `SELECT
        id,
        captured_at,
        gear_hash,
        equipped_item_level,
        average_item_level,
        honorable_kills,
        is_baseline
      FROM character_snapshots
      WHERE character_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    )
    .bind(payload.character.id)
    .first<SnapshotRow>();
  const gearHash = buildGearHash(payload.equipment);
  const snapshotChanged =
    !latest ||
    latest.gear_hash !== gearHash ||
    latest.equipped_item_level !== payload.character.equippedItemLevel ||
    latest.average_item_level !== payload.character.averageItemLevel ||
    latest.honorable_kills !== payload.pvp.honorableKills;

  if (snapshotChanged) {
    const snapshotId = await insertSnapshot(db, payload, gearHash, !latest);

    if (!latest) {
      await insertFirstSeenItems(db, payload, snapshotId, payload.equipment, true);
    } else {
      const knownResult = await db
        .prepare("SELECT item_id FROM character_items WHERE character_id = ?")
        .bind(payload.character.id)
        .all<{ item_id: number }>();
      const knownIds = new Set((knownResult.results ?? []).map((row) => row.item_id));
      const newItems = payload.equipment.filter((item) => !knownIds.has(item.id));
      await insertFirstSeenItems(db, payload, snapshotId, newItems, false);
    }
  }

  return readHistory(db, payload.character.id);
};

export const readRecentGuildGearEvents = async (db: D1Database, limit = 20) => {
  const result = await db
    .prepare(
      `SELECT
        id,
        character_slug,
        item_id,
        item_name,
        item_level,
        quality,
        slot_type,
        occurred_at
      FROM character_gear_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(limit, 50)))
    .all<{
      id: number;
      character_slug: string;
      item_id: number;
      item_name: string;
      item_level: number | null;
      quality: string;
      slot_type: string;
      occurred_at: string;
    }>();

  return (result.results ?? []).map((event) => ({
    id: event.id,
    characterSlug: event.character_slug,
    itemId: event.item_id,
    itemName: event.item_name,
    itemLevel: event.item_level,
    quality: event.quality,
    slot: event.slot_type,
    occurredAt: event.occurred_at,
  }));
};

export const unavailableCharacterHistory = (): CharacterHistoryPayload => ({
  available: false,
  baselineAt: null,
  latestSnapshotAt: null,
  snapshotCount: 0,
  snapshots: [],
  events: [],
});
