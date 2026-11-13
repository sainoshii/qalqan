/**
 * Наполняет базу синтетическими случаями для панели банка.
 *
 *   npm run db:seed            — пересоздать синтетику в DATABASE_URL (по умолчанию data/qalqan.db)
 *
 * Детерминирован в пределах суток (см. seedAnchor). Случаи из демо не удаляются.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createDb, DEFAULT_DATABASE_URL } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/schema";
import { seedSynthetic } from "../src/lib/seed/synthetic";

export { generateCases } from "../src/lib/seed/synthetic";

async function main() {
  const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  if (url.startsWith("file:")) mkdirSync("data", { recursive: true });

  const db = createDb(url, process.env.DATABASE_AUTH_TOKEN || undefined);
  await migrate(db);
  const n = await seedSynthetic(db, readFileSync("data/dataset/messages.jsonl", "utf8"));

  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM cases");
  console.log(`Seed: ${n} синтетических случаев записано, всего в базе: ${rows[0].n} (${url.split("?")[0]})`);
  db.close();
}

if (process.argv[1]?.endsWith("db-seed.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
