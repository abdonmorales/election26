// Loads the JSON schemas and injects the shared source-status definition.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const common = JSON.parse(fs.readFileSync(path.join(dir, "_common.json"), "utf8"));

export function loadSchema(name) {
  const schema = JSON.parse(fs.readFileSync(path.join(dir, `${name}.schema.json`), "utf8"));
  schema.$defs = { ...schema.$defs, sourceStatus: common.sourceStatus };
  return schema;
}
