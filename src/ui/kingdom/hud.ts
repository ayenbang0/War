/**
 * The kingdom map's HUD (docs/audit/u1-kingdom-map.md, u2-economy-panels.md):
 * the top bar (the resources bar, date and weather, speed control,
 * front-screen button), the PAUSED banner, the alerts feed, the pen's result
 * line and the key hint; and the roots the cards and the economy menus draw in.
 *
 * DRIVEN BY EVENTS, not by the frame loop (U1-09, game-ui-ux §5): the layer
 * calls `setDate` on a day boundary, `setRun` when the speed or pause changes,
 * `alert` for a tick event worth telling, `result` after a stroke -- and sets
 * every value once when the HUD is built, because events do not replay. A
 * setter that is handed the value already shown does nothing.
 *
 * Real buttons with text labels (never an icon alone); the speed control is a
 * group of toggle buttons with `aria-pressed`; the alerts and the result line
 * are polite live regions. Every string comes from content/kingdom/ui-strings.ts.
 */

import { K, WEATHER_LINE, dateLine, dateTitle } from "../../content/kingdom/ui-strings.ts";
import type { CalendarDate } from "../../sim/kingdom/clock.ts";
import type { WeatherId } from "../../content/kingdom/terrain.ts";
import { KINGDOM_SPEEDS, type KingdomRun, type KingdomSpeed } from "../../app/kingdom-clock.ts";
import { ResourcesBar } from "./resources.ts";

export type HudActions = {
  setSpeed(s: KingdomSpeed): void;
  pause(): void;
  leave(): void;
};

/** How many alerts the feed keeps on screen. */
const ALERTS_SHOWN = 5;

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * A button press from the mouse should not leave the button focused: the key
 * router leaves Space to a focused button (so the keyboard can press it), and
 * a focused "2x" would turn the next Space -- meant as pause -- into another
 * press of 2x. A keyboard press (detail 0) keeps its focus.
 */
function pressed(b: HTMLElement, e: Event): void {
  if ((e as MouseEvent).detail > 0) b.blur();
}

export class KingdomHud {
  readonly root: HTMLElement;
  /** Where the cards are drawn; the card screens own its contents. */
  readonly cardRoot: HTMLElement;
  /** Where the economy's choice menus are drawn (modal; K3). */
  readonly menuRoot: HTMLElement;
  /** The king's stocks (K3), in the top bar. */
  readonly resources: ResourcesBar;
  private readonly date: HTMLElement;
  private readonly weather: HTMLElement;
  private readonly speedButtons: HTMLElement[] = [];
  private readonly pauseButton: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly alerts: HTMLElement;
  private readonly resultLine: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly interactive: HTMLElement;
  private shownDate = "";
  private shownWeather = "";
  private shownRun = "";
  private readonly alertLines: string[] = [];
  private readonly doc: Document;

  constructor(doc: Document, actions: HudActions) {
    this.doc = doc;
    this.root = make(doc, "div", "kingdom-ui");
    this.root.id = "kingdom-ui";

    // -- top bar -----------------------------------------------------------
    const top = make(doc, "div", "k-top");
    this.interactive = top;
    this.resources = new ResourcesBar(doc);
    const stores = this.resources.root;
    const when = make(doc, "div", "k-box k-date");
    this.date = make(doc, "span", "k-value k-date-line");
    this.weather = make(doc, "span", "k-weather");
    when.append(this.date, this.weather);

    const speed = make(doc, "div", "k-box k-speed");
    speed.setAttribute("role", "group");
    speed.setAttribute("aria-label", K.speedGroup);
    this.pauseButton = make(doc, "button", "k-btn", K.pause);
    this.pauseButton.setAttribute("aria-pressed", "false");
    this.pauseButton.onclick = (e) => { actions.pause(); pressed(this.pauseButton, e); };
    speed.appendChild(this.pauseButton);
    KINGDOM_SPEEDS.forEach((s, i) => {
      const b = make(doc, "button", "k-btn", K.speeds[i]);
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", "Speed " + K.speeds[i]);
      b.onclick = (e) => { actions.setSpeed(s); pressed(b, e); };
      this.speedButtons.push(b);
      speed.appendChild(b);
    });
    const front = make(doc, "button", "k-btn k-front", K.frontScreen);
    front.onclick = () => actions.leave();
    speed.appendChild(front);
    top.append(stores, when, speed);

    // -- banner, feed, result, hint -------------------------------------------
    this.banner = make(doc, "div", "k-paused", K.paused);
    this.banner.setAttribute("role", "status");
    this.banner.style.display = "none";

    const foot = make(doc, "div", "k-foot");
    this.notice = make(doc, "p", "k-notice");
    this.notice.setAttribute("role", "alert");
    this.notice.style.display = "none";
    this.alerts = make(doc, "ol", "k-alerts");
    this.alerts.setAttribute("aria-live", "polite");
    this.alerts.setAttribute("aria-label", "What has happened");
    this.resultLine = make(doc, "p", "k-result");
    this.resultLine.setAttribute("aria-live", "polite");
    foot.append(this.notice, this.alerts, this.resultLine);

    const keys = make(doc, "p", "k-keys", K.keyHint);

    this.cardRoot = make(doc, "aside", "k-card");
    this.cardRoot.style.display = "none";
    this.menuRoot = make(doc, "div", "k-menu-backdrop");
    this.menuRoot.style.display = "none";

    this.root.append(top, this.banner, this.cardRoot, foot, keys, this.menuRoot);
  }

  /** Buttons are live exactly while the map's pen is (a card leaves them usable, a dialog does not). */
  setLive(live: boolean): void {
    this.interactive.inert = !live;
  }

  setShown(shown: boolean): void {
    this.root.style.display = shown ? "block" : "none";
  }

  setDate(d: CalendarDate, weather: WeatherId): void {
    const line = dateLine(d);
    if (line !== this.shownDate) {
      this.shownDate = line;
      this.date.textContent = line;
      this.date.setAttribute("title", dateTitle(d));
    }
    const w = "Weather: " + WEATHER_LINE[weather];
    if (w !== this.shownWeather) {
      this.shownWeather = w;
      this.weather.textContent = w;
    }
  }

  setRun(run: KingdomRun, speed: KingdomSpeed): void {
    const key = run + speed;
    if (key === this.shownRun) return;
    this.shownRun = key;
    const paused = run === "paused";
    this.pauseButton.setAttribute("aria-pressed", String(paused));
    this.pauseButton.classList.toggle("on", paused);
    KINGDOM_SPEEDS.forEach((s, i) => {
      const on = !paused && s === speed;
      this.speedButtons[i].setAttribute("aria-pressed", String(on));
      this.speedButtons[i].classList.toggle("on", on);
    });
    this.banner.style.display = paused ? "block" : "none";
  }

  /** A dated line in the feed, newest first. */
  alert(day: number, text: string): void {
    this.alertLines.unshift("Day " + (day + 1) + "  " + text);
    this.alertLines.length = Math.min(this.alertLines.length, ALERTS_SHOWN);
    this.alerts.textContent = "";
    for (const line of this.alertLines) this.alerts.appendChild(make(this.doc, "li", undefined, line));
  }

  /** What the last stroke did, or why it did nothing. */
  result(text: string): void {
    this.resultLine.textContent = text;
  }

  get resultText(): string {
    return this.resultLine.textContent ?? "";
  }

  get bannerShown(): boolean {
    return this.banner.style.display !== "none";
  }

  /** A standing notice (the realm is not being saved), or null to clear it. */
  setNotice(text: string | null): void {
    this.notice.textContent = text ?? "";
    this.notice.style.display = text ? "block" : "none";
  }

  get noticeText(): string {
    return this.notice.style.display === "none" ? "" : this.notice.textContent ?? "";
  }

  get dateText(): string {
    return this.date.textContent ?? "";
  }
}
