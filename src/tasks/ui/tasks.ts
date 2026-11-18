import { placeholder, type Page } from "../../ui/page.ts";

export const pages: Page[] = [
  { path: "/work", nav: "Work", render: (el) => placeholder(el, "Work", "Tasks and the queue will show here.") },
  { path: "/items/:id", render: (el, { id }) => placeholder(el, `Task ${id}`, "A task's description, criteria and comments will show here.") },
];
