/** What a module's page file exports: one or more pages the shell routes to. */
export interface Page {
  /** e.g. `/work` or `/items/:id`; `:name` parts arrive in `params`. */
  path: string;
  /** Shown in the header's nav when set. Only a few pages have one. */
  nav?: string;
  render(into: HTMLElement, params: Record<string, string>, api: Api): void | Promise<void>;
}

/** Calls the app's API as the signed-in person. */
export interface Api {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
}

/** Matches `path` against a page's pattern; its params, or undefined. */
export function match(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const seg = got[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return undefined;
  }
  return params;
}

/** A placeholder for a page its task has yet to build. */
export function placeholder(into: HTMLElement, title: string, text: string): void {
  const h = into.ownerDocument.createElement("h1");
  h.textContent = title;
  const p = into.ownerDocument.createElement("p");
  p.className = "muted";
  p.textContent = text;
  into.replaceChildren(h, p);
}
