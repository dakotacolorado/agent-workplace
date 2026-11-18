import { TOKEN_KEY } from "../../ui/shell.ts";

export interface Event {
  event: string;
  data: string;
}

/**
 * Follows a server-sent event stream with the signed-in token, calling `on` for each event, and
 * reconnects after a break until `alive()` is false. `path` is called afresh on each connection.
 */
export async function follow(path: () => string, on: (e: Event) => void, alive: () => boolean, doFetch: typeof fetch = (i, n) => globalThis.fetch(i, n)): Promise<void> {
  while (alive()) {
    const ctl = new AbortController();
    const watchdog = setInterval(() => !alive() && ctl.abort(), 1000);
    try {
      const res = await doFetch(path(), { headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}` }, signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          let event = "message";
          const data: string[] = [];
          for (const l of block.split("\n")) {
            if (l.startsWith("event:")) event = l.slice(6).trim();
            else if (l.startsWith("data:")) data.push(l.slice(5).trimStart());
          }
          if (data.length) on({ event, data: data.join("\n") });
        }
      }
    } catch {
      /* reconnect below */
    }
    clearInterval(watchdog);
    if (alive()) await new Promise((r) => setTimeout(r, 2000));
  }
}
