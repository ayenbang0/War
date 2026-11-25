/**
 * Runs the browser e2e scenarios (src/e2e/) on the fake DOM, under Node.
 *
 * NOT a substitute for running e2e.html in a browser: the fake page has no
 * layout, so geometry checks pass trivially and focus/CSS behaviour is only as
 * good as tools/fake-dom.ts models it. What it does catch is a scenario that
 * is wrong in itself, or app wiring that a scenario's event sequence breaks --
 * before anyone spends a browser run on it. `npm run e2e:fake [-- name,...]`.
 */

import { installFakeDom, FakeEvent, FakeElement } from "./fake-dom.ts";

const { win, doc } = installFakeDom();
const out = doc.createElement("pre");
const g = globalThis as unknown as Record<string, unknown>;
class PointerEventLike extends FakeEvent {}
g.PointerEvent = PointerEventLike;
g.MouseEvent = PointerEventLike;
g.KeyboardEvent = PointerEventLike;
g.WheelEvent = PointerEventLike;
g.requestAnimationFrame = (fn: (t: number) => void) => win.requestAnimationFrame(fn);
g.getComputedStyle = (e: InstanceType<typeof FakeElement>) => ({ display: e.shown ? "block" : "none" });
g.innerWidth = win.innerWidth;
g.innerHeight = win.innerHeight;
(win as unknown as Record<string, unknown>).getComputedStyle = g.getComputedStyle;

// The page's frame clock, pumped in real time so the scenarios' waits work.
const pump = setInterval(() => win.runFrames(1), 2);

const { runFromQuery } = await import("../src/e2e/harness.ts");
await import("../src/e2e/scenarios-k0.ts");
await import("../src/e2e/scenarios-k2.ts");
await import("../src/e2e/scenarios-k2fix.ts");
await import("../src/e2e/scenarios-k3.ts");
await import("../src/e2e/scenarios-k3a.ts");
await import("../src/e2e/scenarios-k3b.ts");
await import("../src/e2e/scenarios-k4.ts");
await import("../src/e2e/scenarios-k5.ts");
await import("../src/e2e/scenarios-k6.ts");
await import("../src/e2e/scenarios-k7.ts");
await import("../src/e2e/scenarios-k8.ts");
const only = process.argv[2];
const results = await runFromQuery(only ? "?only=" + only : "", out as unknown as HTMLElement);
clearInterval(pump);
console.log(out.textContent);
console.log("title: " + doc.title);
process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
