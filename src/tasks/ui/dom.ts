/** Small DOM helpers for the Work pages. */
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const inline = (text: string): Node[] => {
  const out: Node[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(h("code", {}, m[1]));
    else if (m[2] !== undefined) out.push(h("strong", {}, m[2]));
    else out.push(h("a", { href: m[4], target: "_blank", rel: "noreferrer" }, m[3]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
};

/** A small Markdown subset (headings, lists, code blocks, paragraphs, inline code, bold, links) as safe DOM, never HTML. */
export function markdown(text: string): HTMLElement {
  const root = h("div", { class: "md" });
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      i++;
      root.append(h("pre", {}, h("code", {}, code.join("\n"))));
    } else if (/^#{1,6} /.test(line)) {
      root.append(h("h4", {}, ...inline(line.replace(/^#+ /, ""))));
      i++;
    } else if (/^\s*[-*] /.test(line)) {
      const ul = h("ul");
      for (; i < lines.length && /^\s*[-*] /.test(lines[i]!); i++) ul.append(h("li", {}, ...inline(lines[i]!.replace(/^\s*[-*] /, ""))));
      root.append(ul);
    } else if (line.trim() === "") i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,6} |\s*[-*] )/.test(lines[i]!); i++) para.push(lines[i]!);
      root.append(h("p", {}, ...inline(para.join(" "))));
    }
  }
  return root;
}
