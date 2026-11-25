/**
 * Browser entry point.
 *
 * Everything lives in the layer controller (app/app.ts): the screen stack, the
 * one key router and the live layer. This file only boots it on the page, so
 * the e2e harness (e2e.html) can boot exactly the same app on its own page.
 */

import { startApp } from "./app/app.ts";

startApp({ win: window, doc: document });
