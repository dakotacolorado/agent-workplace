// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { pages } from "./pages.ts";
import { shell, TOKEN_KEY } from "./shell.ts";

const GOOD = "awp_good";
const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get("Authorization");
  return auth === `Bearer ${GOOD}`
    ? new Response(JSON.stringify({ kind: "person" }), { status: 200 })
    : new Response(JSON.stringify({ error: "no" }), { status: 401 });
}) as typeof fetch;

const navOf = () => [...document.querySelectorAll("nav a")].map((a) => a.textContent);

describe("the page shell", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("signs in from #signin=, drops it from the address, and shows Work, Workers and Skills", async () => {
    history.replaceState(null, "", `/#signin=${GOOD}`);
    await shell(document, { fetch: fakeFetch, pages });
    expect(location.hash).toBe("");
    expect(localStorage.getItem(TOKEN_KEY)).toBe(GOOD);
    expect(document.querySelector("header .name")?.textContent).toBe("agent-workplace");
    expect(navOf()).toEqual(["Work", "Workers", "Skills"]);
    expect(document.querySelector("main h1")?.textContent).toBe("Work");
  });

  it("routes to each page, roles under Skills", async () => {
    localStorage.setItem(TOKEN_KEY, GOOD);
    for (const [path, title] of [["/workers/abc", "Worker abc"], ["/items/1234", "Task 1234"], ["/skills/roles", "Roles"], ["/skills/x", "Skill x"], ["/nope", "Not found"]]) {
      history.replaceState(null, "", path);
      await shell(document, { fetch: fakeFetch, pages });
      expect(document.querySelector("main h1")?.textContent).toBe(title);
    }
  });

  it("asks to sign in, with no nav, when the token is missing or refused", async () => {
    history.replaceState(null, "", "/#signin=awp_bad");
    await shell(document, { fetch: fakeFetch, pages });
    expect(navOf()).toEqual([]);
    expect(document.querySelector("main h1")?.textContent).toBe("Sign in");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
