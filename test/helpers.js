import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixture = (p) => fs.readFileSync(path.join(ROOT, "test", "fixtures", p), "utf8");
export const fixtureJSON = (p) => JSON.parse(fixture(p));
export const dataJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", p), "utf8"));
