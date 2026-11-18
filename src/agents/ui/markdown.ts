/** Renders the markdown agents write into `into`, built from DOM nodes so text is never taken as HTML. */
export function renderMarkdown(doc: Document, into: HTMLElement, text: string): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent?: Node, content?: string) => {
    const e = doc.createElement(tag);
    if (content !== undefined) e.textContent = content;
    parent?.appendChild(e);
    return e;
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```\s*(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      el("code", el("pre", into), body.join("\n"));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      inline(doc, el(`h${Math.min(heading[1]!.length + 2, 6)}` as "h3", into), heading[2]!);
      i++;
      continue;
    }
    const item = /^\s*([-*]|\d+\.)\s+/;
    if (item.test(line)) {
      const list = el(/^\s*\d/.test(line) ? "ol" : "ul", into);
      while (i < lines.length && item.test(lines[i]!)) {
        const parts = [lines[i++]!.replace(item, "")];
        // Wrapped lines of an item belong to it.
        while (i < lines.length && lines[i]!.trim() && !item.test(lines[i]!) && !/^\s*```/.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!)) parts.push(lines[i++]!.trim());
        inline(doc, el("li", list), parts.join("\n"));
      }
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) && !item.test(lines[i]!)) para.push(lines[i++]!);
    inline(doc, el("p", into), para.join("\n"));
  }
}

const SPAN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

function inline(doc: Document, into: HTMLElement, text: string): void {
  let at = 0;
  for (const m of text.matchAll(SPAN)) {
    if (m.index > at) into.append(text.slice(at, m.index));
    if (m[1] !== undefined) into.append(Object.assign(doc.createElement("code"), { textContent: m[1] }));
    else if (m[2] !== undefined) into.append(Object.assign(doc.createElement("strong"), { textContent: m[2] }));
    else if (m[3] !== undefined) into.append(Object.assign(doc.createElement("em"), { textContent: m[3] }));
    else into.append(Object.assign(doc.createElement("a"), { textContent: m[4], href: m[5], target: "_blank", rel: "noreferrer" }));
    at = m.index + m[0].length;
  }
  if (at < text.length) into.append(text.slice(at));
}
