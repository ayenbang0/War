/**
 * Entry point of e2e.html: register the scenarios, run what the query asks for.
 * See harness.ts for how to run it and what the output means.
 */

import { runFromQuery } from "./harness.ts";
import "./scenarios-k0.ts";
import "./scenarios-k2.ts";

const out = document.getElementById("e2e-results") as HTMLElement;
document.title = "E2E RUNNING";
void runFromQuery(location.search, out).catch((err: unknown) => {
  out.textContent = "FAIL  harness crashed: " + String(err);
  document.title = "E2E FAIL harness";
});
