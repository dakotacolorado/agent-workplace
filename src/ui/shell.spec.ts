// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { pages } from "./pages.ts";
import { shell, TOKEN_KEY } from "./shell.ts";

const GOOD = "awp_good";
const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get("Authorization");
  return auth === `Bearer ${GOOD}`
    ? new Response(JSON.stringify({ kind: "person", tasks: [], labels: [], entries: [], comments: [], task: { title: "Task 1234", id: "1234", shortId: "1234", description: "", status: "backlog", dependsOn: [], blockedBy: [], subtasks: [], criteria: [], labels: [], assignee: null, ready: true } }), { status: 200 })
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

  it("tells someone without the link to run setup.sh and names the admin-token file", async () => {
    await shell(document, { fetch: fakeFetch, pages });
    const text = document.querySelector("main")?.textContent ?? "";
    expect(text).toContain("scripts/setup.sh");
    expect(text).toContain("admin-token");
    expect(document.querySelector("main input[type=password]")).not.toBeNull();
  });

  it("signs in when the pasted admin token is accepted", async () => {
    await shell(document, { fetch: fakeFetch, pages });
    const field = document.querySelector<HTMLInputElement>("main input[type=password]")!;
    field.value = GOOD;
    document.querySelector("main form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(localStorage.getItem(TOKEN_KEY)).toBe(GOOD);
  });

  it("shows 'That token was not accepted.' and stays on the sign-in page for a wrong token", async () => {
    await shell(document, { fetch: fakeFetch, pages });
    const field = document.querySelector<HTMLInputElement>("main input[type=password]")!;
    field.value = "nope";
    document.querySelector("main form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(document.querySelector("main [role=alert]")?.textContent).toBe("That token was not accepted.");
    expect(document.querySelector("main h1")?.textContent).toBe("Sign in");
    expect(navOf()).toEqual([]);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
