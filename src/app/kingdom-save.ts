/**
 * Browser-side storage for the kingdom save (PLAN.md §B.10).
 *
 * Outside src/sim/ on purpose: the sim knows the save FORMAT (sim/kingdom/
 * save.ts, pure and headless), this file knows where it is kept. It replaces
 * the battle campaign's `war.chronicle.v1` once K9 cuts the old campaign over.
 *
 * Crash safety is write-then-swap. localStorage has no atomic rename, but each
 * single setItem is atomic, so:
 *   1. write the new save under a temporary key and read it back;
 *   2. copy it over the real key;
 *   3. remove the temporary key.
 * A crash before 2 leaves the old save intact under the real key and a
 * complete, verified new one under the temporary key; a crash after 2 leaves
 * both keys holding the new save. On load a present, valid temporary key
 * therefore always holds the newest save (it is removed only once the swap
 * has finished), so it wins, and the interrupted swap is completed.
 *
 * Nothing here throws at the caller. Storage can be missing (private modes,
 * sandboxed frames), full, or refused by policy, and every one of those comes
 * back as a result value the UI can show -- never swallowed, never thrown.
 */

import { loadFromJson, saveToJson } from "../sim/kingdom/save.ts";
import type { KingdomWorld } from "../sim/kingdom/world.ts";

export const KINGDOM_SAVE_KEY = "war.kingdom.v1";
export const KINGDOM_SAVE_TEMP_KEY = KINGDOM_SAVE_KEY + ".tmp";

/** The part of the Web Storage API used here, so tests can pass a fake. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StorageFailure =
  /** No storage at all in this browser context. */
  | "unavailable"
  /** The browser refused the write: quota, or storage disabled by policy. */
  | "refused"
  /** The write appeared to succeed but did not read back identically. */
  | "unverified"
  /** What is stored is not a loadable kingdom save. */
  | "corrupt";

export type SaveOutcome =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: StorageFailure; readonly detail: string };

export type LoadOutcome =
  /** `recovered` is true when an interrupted save was found and completed. */
  | { readonly ok: true; readonly world: KingdomWorld; readonly recovered: boolean }
  /** Nothing saved yet: a new game, not an error. */
  | { readonly ok: true; readonly world: null; readonly recovered: false }
  | { readonly ok: false; readonly reason: StorageFailure; readonly detail: string };

/** The page's localStorage, or null where touching it is refused. */
export function browserStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    // Some browsers throw on the mere property access when storage is blocked.
    return null;
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.name + ": " + e.message : String(e);
}

/** Save the world, crash-safely. */
export function saveKingdom(world: KingdomWorld, storage: StorageLike | null = browserStorage()): SaveOutcome {
  if (!storage) return { ok: false, reason: "unavailable", detail: "this browser offers no local storage" };
  const json = saveToJson(world);
  try {
    storage.setItem(KINGDOM_SAVE_TEMP_KEY, json);
  } catch (e) {
    // The old save is untouched; drop the partial temp copy if there is one.
    try { storage.removeItem(KINGDOM_SAVE_TEMP_KEY); } catch { /* already reported below */ }
    return { ok: false, reason: "refused", detail: describe(e) };
  }
  let readBack: string | null;
  try {
    readBack = storage.getItem(KINGDOM_SAVE_TEMP_KEY);
  } catch (e) {
    return { ok: false, reason: "refused", detail: describe(e) };
  }
  if (readBack !== json) {
    return { ok: false, reason: "unverified", detail: "the save did not read back as written; the previous save is kept" };
  }
  try {
    storage.setItem(KINGDOM_SAVE_KEY, json);
  } catch (e) {
    // The verified temp copy stays: the next load finds and finishes it.
    return { ok: false, reason: "refused", detail: describe(e) };
  }
  try {
    storage.removeItem(KINGDOM_SAVE_TEMP_KEY);
  } catch {
    // Harmless: both keys now hold the same save, and load prefers the temp.
  }
  return { ok: true, bytes: json.length };
}

/** Load the saved world, finishing an interrupted save if one is found. */
export function loadKingdom(storage: StorageLike | null = browserStorage()): LoadOutcome {
  if (!storage) return { ok: false, reason: "unavailable", detail: "this browser offers no local storage" };
  let temp: string | null;
  let main: string | null;
  try {
    temp = storage.getItem(KINGDOM_SAVE_TEMP_KEY);
    main = storage.getItem(KINGDOM_SAVE_KEY);
  } catch (e) {
    return { ok: false, reason: "refused", detail: describe(e) };
  }

  if (temp !== null) {
    const t = loadFromJson(temp);
    if (t.ok) {
      // Complete the swap; if that write is refused the temp copy still
      // stands, so the game loads correctly next time too.
      try {
        storage.setItem(KINGDOM_SAVE_KEY, temp);
        storage.removeItem(KINGDOM_SAVE_TEMP_KEY);
      } catch { /* the loaded world is still the right one */ }
      return { ok: true, world: t.value, recovered: true };
    }
    // A temp copy that does not load was cut off mid-write; the real key
    // still holds the last good save.
  }

  if (main === null) return { ok: true, world: null, recovered: false };
  const m = loadFromJson(main);
  if (!m.ok) return { ok: false, reason: "corrupt", detail: m.error };
  return { ok: true, world: m.value, recovered: false };
}

/** Remove every stored copy (a new campaign). */
export function clearKingdom(storage: StorageLike | null = browserStorage()): SaveOutcome {
  if (!storage) return { ok: false, reason: "unavailable", detail: "this browser offers no local storage" };
  try {
    storage.removeItem(KINGDOM_SAVE_TEMP_KEY);
    storage.removeItem(KINGDOM_SAVE_KEY);
  } catch (e) {
    return { ok: false, reason: "refused", detail: describe(e) };
  }
  return { ok: true, bytes: 0 };
}

/** The save as a JSON string, for an export file. */
export function exportKingdom(world: KingdomWorld): string {
  return saveToJson(world);
}

/** Read an exported save. Never throws; a bad file is a "corrupt" result. */
export function importKingdom(text: string): LoadOutcome {
  const r = loadFromJson(text);
  if (!r.ok) return { ok: false, reason: "corrupt", detail: r.error };
  return { ok: true, world: r.value, recovered: false };
}
