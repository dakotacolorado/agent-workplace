import { match, type Api, type Page } from "./page.ts";

export const TOKEN_KEY = "agent-workplace-token";

export interface ShellOptions {
  fetch: typeof globalThis.fetch;
  pages: Page[];
}

/** The page: signs in from `#signin=<token>`, draws the header and nav, and routes to each page. */
export async function shell(doc: Document, options: ShellOptions): Promise<void> {
  const win = doc.defaultView!;
  const signin = /(?:^#|&)signin=([^&]+)/.exec(win.location.hash)?.[1];
  if (signin) {
    win.localStorage.setItem(TOKEN_KEY, decodeURIComponent(signin));
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
  }
  const token = win.localStorage.getItem(TOKEN_KEY);

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await options.fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `${method} ${path}: ${res.status}`);
    return data;
  };
  const api: Api = { get: (path) => call("GET", path), send: (method, path, body) => call(method, path, body) };

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) =>
    Object.assign(doc.createElement(tag), props);

  const header = el("header");
  const name = el("a", { href: "/work", className: "name", textContent: "agent-workplace" });
  const nav = el("nav");
  header.append(name, nav);
  const main = el("main");
  doc.body.replaceChildren(header, main);

  const signedIn = token ? await api.get("/api/me").then(() => true, () => false) : false;
  if (!signedIn) {
    win.localStorage.removeItem(TOKEN_KEY);
    const hint = el("p");
    hint.append(
      "Lost the link? Run ",
      el("code", { textContent: "scripts/setup.sh" }),
      " again (or the one-line setup from the README) and it prints the link again. Or paste the token from ",
      el("code", { textContent: "~/.agent-workplace/admin-token" }),
      " (or ",
      el("code", { textContent: "$AGENT_WORKPLACE_DIR/admin-token" }),
      ") below.",
    );
    const field = doc.createElement("input");
    Object.assign(field, { type: "password", name: "token", required: true, autocomplete: "off" });
    const refused = el("p", { className: "error" });
    refused.setAttribute("role", "alert");
    const label = doc.createElement("label");
    label.append("Admin token ", field);
    const form = el("form");
    form.append(label, refused, el("button", { type: "submit", textContent: "Sign in" }));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const pasted = field.value.trim();
      const accepted =
        pasted !== "" &&
        (await options.fetch("/api/me", { headers: { Authorization: `Bearer ${pasted}` } }).then(
          (res) => res.ok,
          () => false,
        ));
      if (!accepted) {
        refused.textContent = "That token was not accepted.";
        field.select();
        return;
      }
      win.localStorage.setItem(TOKEN_KEY, pasted);
      win.location.reload();
    });
    main.append(el("h1", { textContent: "Sign in" }), el("p", { textContent: "Open the sign-in link agent-workplace printed when it started (it ends #signin=…)." }), hint, form);
    return;
  }

  const links = options.pages.filter((p) => p.nav).map((p) => el("a", { href: p.path, textContent: p.nav! }));
  nav.append(...links);

  const go = async () => {
    const path = win.location.pathname === "/" ? "/work" : win.location.pathname;
    for (const a of links) a.toggleAttribute("aria-current", path === a.pathname || path.startsWith(a.pathname + "/"));
    const exact = options.pages.find((p) => p.path === path);
    const found = exact ? { page: exact, params: {} } : options.pages.map((page) => ({ page, params: match(page.path, path) })).find((m) => m.params);
    if (!found?.params) {
      main.replaceChildren(el("h1", { textContent: "Not found" }), el("p", { textContent: `Nothing is at ${path}.` }));
      return;
    }
    main.replaceChildren();
    await found.page.render(main, found.params, api);
  };
  doc.addEventListener("click", (event) => {
    const a = (event.target as Element | null)?.closest?.("a");
    if (!a || a.origin !== win.location.origin || event.defaultPrevented || (event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey) return;
    event.preventDefault();
    win.history.pushState(null, "", a.pathname + a.search);
    void go();
  });
  win.addEventListener("popstate", () => void go());
  await go();
}
