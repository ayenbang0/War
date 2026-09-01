/**
 * Lockstep verification.
 *
 * This is the claim the project has been paying for since Phase 0: that two
 * machines fed an identical order stream compute an identical battle, tick for
 * tick, forever. Every determinism rule in CLAUDE.md -- the banned
 * transcendentals, the seeded per-subsystem streams, the fixed tick, the sorted
 * order queue, the tie-breaks on entity id -- exists to make this true.
 *
 * No network here on purpose. A relay and a matchmaker are infrastructure; what
 * needs proving first is that the SIMULATION is deterministic enough for them
 * to be worth building. Two World instances in one process, fed one order
 * stream and hash-compared, prove exactly that -- and if this ever fails, no
 * amount of netcode would have saved it.
 */

import { World, TICK_RATE } from "../src/sim/world.ts";
import { hashWorld } from "../src/sim/hash.ts";
import { provingGround } from "../src/content/levels/proving-ground.ts";
import { UNIT_TYPES, type UnitTypeId } from "../src/content/unit-types.ts";
import { TILE_SIZE } from "../src/sim/terrain.ts";
import type { Order } from "../src/sim/orders.ts";
import * as M from "../src/sim/math.ts";

export type Check = { name: string; ok: boolean; detail: string };

const ARMY: readonly UnitTypeId[] = [
  "line", "line", "line", "archer", "archer",
  "skirmisher", "skirmisher", "horse", "guard", "scout",
];

/** Build one peer. Identical inputs must produce an identical world. */
function peer(ai: boolean): World {
  const w = new World({
    seed: provingGround.seed,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
    duration: 15 * 60,
    soldierCapacity: 2048,
    aiPlayers: ai ? [0, 1] : [],
  });
  for (const zone of provingGround.deployment) {
    for (let i = 0; i < ARMY.length; i++) {
      const type = ARMY[i];
      const bx = (zone.x + 3 + (i % 4) * 5) * TILE_SIZE;
      const by = (zone.y + 5 + ((i / 4) | 0) * 9) * TILE_SIZE;
      for (let k = 0; k < UNIT_TYPES[type].soldiers; k++) {
        w.spawnSoldier(
          zone.player, type,
          bx + (k % 5) * 14, by + ((k / 5) | 0) * 14,
          zone.player === 0 ? 0 : M.PI,
        );
      }
    }
  }
  return w;
}

/**
 * Group every army and send both sides at each other, recording the orders.
 *
 * The recorded stream is what a peer would receive over the wire, so it is
 * built once and applied to both worlds rather than generated twice -- two
 * peers must never independently decide what the orders were.
 */
function openingOrders(w: World): Order[] {
  const log: Order[] = [];
  for (const player of [0, 1]) {
    const men = w.soldiersOf(player);
    // Four groups a side, carved from the deployment in a fixed order.
    const per = Math.ceil(men.length / 4);
    for (let g = 0; g < 4; g++) {
      const slice = men.slice(g * per, (g + 1) * per);
      if (slice.length === 0) continue;
      const group = w.createGroup(player, slice);
      if (!group) continue;
      const toward = player === 0 ? 1 : -1;
      log.push(
        w.orders.issue(
          {
            kind: "move",
            squad: group.id,
            path: [group.anchorX + toward * 1500, group.anchorY + (g - 1.5) * 220],
          },
          player,
          6 + g * 5,
        ),
      );
    }
  }
  return log;
}

/**
 * Rebuild the same groups on the other peer, WITHOUT re-deciding anything.
 *
 * Group membership is state, and a peer that formed its groups independently
 * could disagree about who is in which -- so the second world is given exactly
 * the same soldier ids in exactly the same order. In a real session this is
 * what the "form group" command would carry.
 */
function replayGroups(w: World): void {
  for (const player of [0, 1]) {
    const men = w.soldiersOf(player);
    const per = Math.ceil(men.length / 4);
    for (let g = 0; g < 4; g++) {
      const slice = men.slice(g * per, (g + 1) * per);
      if (slice.length > 0) w.createGroup(player, slice);
    }
  }
}

export function runLockstep(): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
  };

  // -- 1. two peers, one order stream ----------------------------------------
  {
    const TICKS = TICK_RATE * 150;
    const a = peer(false);
    const b = peer(false);
    const log = openingOrders(a);
    replayGroups(b);
    for (const o of log) b.orders.push(o);

    let diverged = -1;
    let compared = 0;
    for (let t = 0; t < TICKS; t++) {
      a.step();
      b.step();
      if (t % 10 !== 0) continue;
      compared++;
      if (hashWorld(a) !== hashWorld(b)) {
        diverged = t;
        break;
      }
    }
    add(
      "two peers on one order stream never diverge",
      diverged < 0,
      diverged >= 0 ? "diverged at tick " + diverged : compared + " comparisons over " + TICKS + " ticks",
    );
    add("the battle actually happened", a.soldiers.count > 0 && a.tick === TICKS,
      a.tick + " ticks, " + (a.soldiersOf(0).length + a.soldiersOf(1).length) + " alive");
  }

  // -- 2. the strongest form: no orders at all, both sides machine-run --------
  {
    const TICKS = TICK_RATE * 240;
    const a = peer(true);
    const b = peer(true);
    let diverged = -1;
    for (let t = 0; t < TICKS; t++) {
      a.step();
      b.step();
      if (t % 20 === 0 && hashWorld(a) !== hashWorld(b)) {
        diverged = t;
        break;
      }
    }
    add(
      "two AI-run matches from one seed stay identical",
      diverged < 0,
      diverged >= 0 ? "diverged at tick " + diverged : TICKS + " ticks with no orders supplied",
    );
  }

  // -- 3. the detector must detect ------------------------------------------
  //
  // A desync check that cannot see a desync is worse than none: it would report
  // green forever while two peers drifted apart. Nudge one world by a ten
  // thousandth of a world unit and insist the comparison catches it.
  {
    const a = peer(false);
    const b = peer(false);
    const log = openingOrders(a);
    replayGroups(b);
    for (const o of log) b.orders.push(o);
    for (let t = 0; t < 60; t++) {
      a.step();
      b.step();
    }
    const clean = hashWorld(a) === hashWorld(b);
    b.soldiers.x[0] += 0.0001;

    let caught = -1;
    for (let t = 0; t < 200 && caught < 0; t++) {
      a.step();
      b.step();
      if (hashWorld(a) !== hashWorld(b)) caught = t;
    }
    add("identical before the nudge", clean);
    add(
      "a one-ten-thousandth nudge is caught",
      caught >= 0,
      caught >= 0 ? "caught after " + caught + " ticks" : "NEVER CAUGHT",
    );
  }

  // -- 4. replay from a recorded log ----------------------------------------
  //
  // The same property a spectator or a saved replay depends on: the log alone,
  // with no live state, must reproduce the match exactly.
  {
    const TICKS = TICK_RATE * 120;
    const live = peer(false);
    const log = openingOrders(live);
    for (let t = 0; t < TICKS; t++) live.step();
    const liveHash = hashWorld(live);

    const replayed = peer(false);
    replayGroups(replayed);
    for (const o of log) replayed.orders.push(o);
    for (let t = 0; t < TICKS; t++) replayed.step();

    add("a recorded log reproduces the match", hashWorld(replayed) === liveHash,
      liveHash + " vs " + hashWorld(replayed));
  }

  // -- 5. order arrival order must not matter --------------------------------
  //
  // Peers receive orders in whatever sequence the network delivers them. The
  // queue sorts by (tick, player, seq), so a shuffled arrival must still
  // produce the same battle -- otherwise latency alone would desync a match.
  {
    const TICKS = TICK_RATE * 90;
    const a = peer(false);
    const log = openingOrders(a);
    for (let t = 0; t < TICKS; t++) a.step();

    const b = peer(false);
    replayGroups(b);
    for (const o of [...log].reverse()) b.orders.push(o);
    for (let t = 0; t < TICKS; t++) b.step();

    add("orders arriving out of sequence change nothing", hashWorld(a) === hashWorld(b),
      hashWorld(a) + " vs " + hashWorld(b));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

const report = runLockstep();
console.log("");
console.log("lockstep");
for (const c of report.checks) {
  console.log("  " + (c.ok ? "PASS  " : "FAIL  ") + c.name + (c.detail ? "  <- " + c.detail : ""));
}
console.log("");
console.log(report.ok ? "lockstep verified" : "LOCKSTEP BROKEN");
console.log("");
process.exit(report.ok ? 0 : 1);
