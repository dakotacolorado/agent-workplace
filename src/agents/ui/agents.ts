import { placeholder, type Page } from "../../ui/page.ts";

export const pages: Page[] = [
  { path: "/workers", nav: "Workers", render: (el) => placeholder(el, "Workers", "The agents and what each is doing will show here.") },
  { path: "/workers/:id", render: (el, { id }) => placeholder(el, `Worker ${id}`, "An agent's transcript will show here.") },
];
