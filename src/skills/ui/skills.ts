import { placeholder, type Page } from "../../ui/page.ts";

export const pages: Page[] = [
  { path: "/skills", nav: "Skills", render: (el) => placeholder(el, "Skills", "The skills agents work by, and their roles, will show here.") },
  { path: "/skills/:name", render: (el, { name }) => placeholder(el, `Skill ${name}`, "A skill's files, versions and feedback will show here.") },
];
