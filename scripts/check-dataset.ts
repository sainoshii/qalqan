/**
 * Проверяет data/dataset/messages.jsonl и печатает сводку.
 *   npm run data:check
 */
import { readFileSync } from "node:fs";
import { parseDataset, summarize } from "../src/lib/dataset";

const path = process.argv[2] ?? "data/dataset/messages.jsonl";
const { items, errors } = parseDataset(readFileSync(path, "utf8"));

if (errors.length) {
  console.error(`Ошибки в ${path}:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`${path}: OK`);
console.log(JSON.stringify(summarize(items), null, 2));
