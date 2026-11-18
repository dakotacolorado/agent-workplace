import type { Page } from "../../ui/page.ts";
import { renderItem } from "./item.ts";
import { renderWork } from "./work.ts";

export const pages: Page[] = [
  { path: "/work", nav: "Work", render: (el, _p, api) => renderWork(el, api) },
  { path: "/items/:id", render: (el, { id }, api) => renderItem(el, id!, api) },
];
