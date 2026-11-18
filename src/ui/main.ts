import "./style.css";
import { pages } from "./pages.ts";
import { shell } from "./shell.ts";

void shell(document, { fetch: (input, init) => globalThis.fetch(input, init), pages });
