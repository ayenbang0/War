/**
 * Where the chronicle is kept: localStorage when the browser allows it, and
 * memory always.
 *
 * BS-01 (the audit's one P0): with storage refused -- a private window, a
 * blocked site, a full quota -- every save was swallowed silently, and since
 * every return to the chronicle was a page reload, the campaign could never get
 * past chapter 1 and nothing said why. Now the copy in memory is the truth for
 * the session, the screens are never reloaded, and the store says out loud when
 * it cannot write, so the chronicle screen can tell the player.
 *
 * The storage provider is injected so the e2e harness can stand in a refusing
 * one, and so nothing here touches `window` at import time.
 */

import { freshProgress, readProgress, type Progress } from "../content/campaign.ts";

export const CHRONICLE_KEY = "war.chronicle.v1";
const PROBE_KEY = "war.probe";

/** The part of the Web Storage API used here. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StorageStatus =
  | { readonly kind: "saved" }
  /** The browser refused; progress lives in memory until the tab closes. */
  | { readonly kind: "memory-only"; readonly reason: string };

function describe(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) return String((err as { name: unknown }).name);
  return "refused";
}

export class ProgressStore {
  private current: Progress;
  private backing: KeyValueStore | null = null;
  status: StorageStatus = { kind: "saved" };

  /**
   * Probe once, up front: a refusal can come from merely touching
   * `window.localStorage` (a SecurityError), from reading, or only from
   * writing (Safari's old private mode, a full quota). All three end in memory.
   */
  constructor(provider: () => KeyValueStore | null) {
    let raw: string | null = null;
    try {
      const s = provider();
      if (!s) throw new Error("no storage");
      s.setItem(PROBE_KEY, "1");
      s.removeItem(PROBE_KEY);
      raw = s.getItem(CHRONICLE_KEY);
      this.backing = s;
    } catch (err) {
      this.refuse(err);
    }
    this.current = readProgress(raw);
  }

  /** The chronicle as it stands. A copy, so callers cannot edit it in place. */
  load(): Progress {
    return { ...this.current, record: this.current.record.slice() };
  }

  save(p: Progress): void {
    this.current = { ...p, record: p.record.slice() };
    if (!this.backing) return;
    try {
      this.backing.setItem(CHRONICLE_KEY, JSON.stringify(this.current));
    } catch (err) {
      // Refused part-way through a session: carry on from memory, and say so.
      this.refuse(err);
    }
  }

  reset(): void {
    this.save(freshProgress());
  }

  private refuse(err: unknown): void {
    this.backing = null;
    this.status = { kind: "memory-only", reason: describe(err) };
  }
}

/** The line shown wherever the player would otherwise assume it was saved. */
export const MEMORY_ONLY_NOTICE =
  "This browser is refusing to store anything, so the chronicle is kept only until this tab is closed.";
