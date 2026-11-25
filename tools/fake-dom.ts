/**
 * A very small fake DOM, just enough to boot the real app (src/app/app.ts)
 * under Node and walk its screens with clicks and keys.
 *
 * It models only what the app's screens use: elements with children, text,
 * classes, inline style, focus, inert, click handlers, events that bubble to
 * the document and the window, and a few selectors. Layout is reduced to one
 * question -- is this element shown? -- answered from inline `display` and the
 * stylesheet's few `display: none` defaults. It is not a browser: real pointer
 * strokes, real focus movement and real CSS are the e2e harness's job.
 */

type Listener = (e: FakeEvent) => void;

export class FakeEvent {
  readonly type: string;
  target: unknown = null;
  defaultPrevented = false;
  propagationStopped = false;
  [key: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

class Listeners {
  private readonly map = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    const l = this.map.get(type) ?? [];
    l.push(fn);
    this.map.set(type, l);
  }
  removeEventListener(type: string, fn: Listener): void {
    const l = this.map.get(type);
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  fire(e: FakeEvent): void {
    for (const fn of (this.map.get(e.type) ?? []).slice()) fn(e);
  }
  count(): number {
    let n = 0;
    for (const l of this.map.values()) n += l.length;
    return n;
  }
}

/** Stylesheet defaults that hide an element until inline style shows it. */
function hiddenByStylesheet(el: FakeElement): boolean {
  const cls = el.className.split(/\s+/);
  if (cls.includes("home") || cls.includes("after-action") || cls.includes("dialog") || cls.includes("ability-bar")) return true;
  if (el.id === "menu") return true;
  // #hud:empty { display: none }
  if (el.id === "hud" && el.textContent === "") return true;
  return false;
}

function fakeContext(): unknown {
  return new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "createRadialGradient" || k === "createLinearGradient" || k === "createPattern") return () => ({ addColorStop() {} });
      if (k === "measureText") return () => ({ width: 10 });
      if (k === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
}

export class FakeElement extends Listeners {
  readonly tagName: string;
  readonly doc: FakeDocument;
  id = "";
  className = "";
  title = "";
  type = "";
  disabled = false;
  inert = false;
  isContentEditable = false;
  width = 300;
  height = 150;
  style: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  onclick: ((e: FakeEvent) => void) | null = null;
  private text = "";
  private readonly attrs = new Map<string, string>();

  constructor(doc: FakeDocument, tag: string) {
    super();
    this.doc = doc;
    this.tagName = tag.toUpperCase();
  }

  get classList(): { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean } {
    const get = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const set = (l: string[]): void => { this.className = l.join(" "); };
    return {
      add: (c) => { const l = get(); if (!l.includes(c)) set([...l, c]); },
      remove: (c) => set(get().filter((x) => x !== c)),
      toggle: (c, on) => {
        const has = get().includes(c);
        const want = on ?? !has;
        if (want && !has) set([...get(), c]);
        if (!want && has) set(get().filter((x) => x !== c));
      },
      contains: (c) => get().includes(c),
    };
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.text = v;
    this.doc.dropFocusIfDetached();
  }
  set innerHTML(v: string) {
    if (v !== "") throw new Error("fake DOM: innerHTML only clears");
    this.textContent = "";
  }

  appendChild(c: FakeElement): FakeElement {
    c.parentNode?.removeChild(c);
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  append(...cs: FakeElement[]): void {
    for (const c of cs) this.appendChild(c);
  }
  insertBefore(n: FakeElement, ref: FakeElement | null): FakeElement {
    n.parentNode?.removeChild(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(c: FakeElement): void {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
  }

  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }

  get isConnected(): boolean {
    let n: FakeElement | null = this;
    while (n) {
      if (n === this.doc.body) return true;
      n = n.parentNode;
    }
    return false;
  }

  /** Shown: connected, and neither it nor any ancestor is display:none. */
  get shown(): boolean {
    if (!this.isConnected) return false;
    let n: FakeElement | null = this;
    while (n) {
      const d = n.style.display;
      if (d === "none") return false;
      if ((d === undefined || d === "") && hiddenByStylesheet(n)) return false;
      n = n.parentNode;
    }
    return true;
  }

  getClientRects(): unknown[] {
    return this.shown ? [{}] : [];
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 };
  }

  closest(sel: string): FakeElement | null {
    let n: FakeElement | null = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }

  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (sel.split(",").some((s) => matchesChain(c, s.trim(), this))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  focus(): void {
    if (this.shown && !this.closest("[inert]")) this.doc.activeElement = this;
  }
  blur(): void {
    if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
  }

  dispatchEvent(e: FakeEvent): boolean {
    e.target = this;
    let n: FakeElement | null = this;
    // A disabled control receives no clicks, synthetic or not.
    if (e.type === "click" && this.disabled) return false;
    while (n && !e.propagationStopped) {
      // onclick is an event-handler property: a dispatched click runs it.
      if (e.type === "click") n.onclick?.(e);
      n.fire(e);
      n = n.parentNode;
    }
    if (!e.propagationStopped) this.doc.fire(e);
    if (!e.propagationStopped) this.doc.win.fire(e);
    return !e.defaultPrevented;
  }

  /**
   * HTMLElement.click(): fires even on a hidden element (the setup screen
   * clicks its own "Suggest an army" while it is being built), never on a
   * disabled one. Tests that stand for a player find only shown buttons.
   */
  click(): void {
    this.dispatchEvent(new FakeEvent("click"));
  }

  // canvas
  getContext(): unknown { return fakeContext(); }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  hasPointerCapture(): boolean { return false; }
}

/** One simple selector: tag, .class, #id, [attr] or [attr='v'] / :not([tabindex='-1']). */
function matches(el: FakeElement, sel: string): boolean {
  let rest = sel;
  const notM = /:not\(\[(\w+)='([^']*)'\]\)/.exec(rest);
  if (notM) {
    if (el.getAttribute(notM[1]) === notM[2]) return false;
    rest = rest.replace(notM[0], "");
  }
  const re = /^([a-zA-Z][a-zA-Z0-9]*)?((?:[.#][\w-]+)*)((?:\[[\w-]+\])*)$/;
  const m = re.exec(rest);
  if (!m) throw new Error("fake DOM: unsupported selector " + sel);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === "." && !el.classList.contains(part.slice(1))) return false;
    if (part[0] === "#" && el.id !== part.slice(1)) return false;
  }
  for (const a of m[3].match(/\[[\w-]+\]/g) ?? []) {
    const name = a.slice(1, -1);
    if (name === "inert") { if (!el.inert) return false; } else if (!el.hasAttribute(name)) return false;
  }
  return true;
}

/** A descendant chain ("#menu .choice.on") matched within `scope`. */
function matchesChain(el: FakeElement, sel: string, scope: FakeElement): boolean {
  const parts = sel.split(/\s+/);
  if (!matches(el, parts[parts.length - 1])) return false;
  let n = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (n && n !== scope.parentNode && !matches(n, parts[i])) n = n.parentNode;
    if (!n) return false;
    n = n.parentNode;
  }
  return true;
}

export class FakeWindow extends Listeners {
  innerWidth = 1280;
  innerHeight = 720;
  devicePixelRatio = 1;
  private frames = new Map<number, (t: number) => void>();
  private nextFrame = 1;
  private now = 1000;
  localStorage: unknown = null;
  requestAnimationFrame(fn: (t: number) => void): number {
    const id = this.nextFrame++;
    this.frames.set(id, fn);
    return id;
  }
  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }
  /** Run the pending frames `n` times, 50 ms (one sim tick) apart. */
  runFrames(n: number): void {
    for (let i = 0; i < n; i++) {
      const q = [...this.frames.values()];
      this.frames.clear();
      this.now += 50;
      for (const f of q) f(this.now);
    }
  }
  pendingFrames(): number {
    return this.frames.size;
  }
  listenerCount(): number {
    return this.count();
  }
}

export class FakeDocument extends Listeners {
  readonly win: FakeWindow;
  readonly body: FakeElement;
  activeElement: FakeElement;
  hidden = false;
  constructor(win: FakeWindow, ids: readonly string[]) {
    super();
    this.win = win;
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
    for (const id of ids) {
      const e = new FakeElement(this, id === "stage" ? "canvas" : "div");
      e.id = id;
      if (id === "hud") e.className = "panel";
      this.body.appendChild(e);
    }
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  getElementById(id: string): FakeElement | null {
    return this.body.querySelectorAll("#" + id)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.body.querySelectorAll(sel);
  }
  querySelector(sel: string): FakeElement | null {
    return this.body.querySelector(sel);
  }
  /**
   * The topmost full-window element at a point. The screens are all fixed and
   * full-window, so the answer is the highest shown one by z-index, or the
   * canvas when none is up (the HUD and the ability strip let the pointer through).
   */
  elementFromPoint(): FakeElement | null {
    for (const id of ["dialog", "home", "chronicle", "report", "menu"]) {
      const e = this.getElementById(id);
      // An empty root has no area: a real pointer passes straight through it.
      if (e && e.shown && e.children.length > 0) return e;
    }
    return this.getElementById("stage");
  }
  title = "";
  dropFocusIfDetached(): void {
    if (!this.activeElement.isConnected) this.activeElement = this.body;
  }
}

/** Build a page with index.html's elements and install it as the globals. */
export function installFakeDom(): { win: FakeWindow; doc: FakeDocument } {
  const win = new FakeWindow();
  const doc = new FakeDocument(win, ["stage", "home", "chronicle", "menu", "report", "hud", "abilities", "dialog"]);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = doc;
  g.window = win;
  g.HTMLElement = FakeElement;
  return { win, doc };
}
