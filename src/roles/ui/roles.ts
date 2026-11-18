import { placeholder, type Page } from "../../ui/page.ts";

/** Roles live under Skills. Listed after the skills module's pages, `/skills/roles` wins over `/skills/:name` by being exact. */
export const pages: Page[] = [{ path: "/skills/roles", render: (el) => placeholder(el, "Roles", "The roles agents work in will show here.") }];
