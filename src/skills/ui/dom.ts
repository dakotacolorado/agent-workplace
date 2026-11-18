type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** Makes an element with properties (`class`, `on<event>`, anything else set as a property) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && k !== "list") (el as unknown as Props)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** A skill's address: `/skills/<name>`, the name's own slashes kept. */
export const skillHref = (name: string) => `/skills/${name.split("/").map(encodeURIComponent).join("/")}`;

/** The API path of a skill, its name as one segment. */
export const skillApi = (name: string, rest = "") => `/api/skills/${encodeURIComponent(name)}${rest}`;

export const when = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) : "");

/** Shows an error under a form or button row. */
export function failure(into: HTMLElement, e: unknown) {
  into.textContent = e instanceof Error ? e.message : String(e);
  into.hidden = false;
}
