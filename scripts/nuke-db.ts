/**
 * Wipe every collection in the `risksi` database. Requires `--confirm` on
 * the command line so an accidental run from a terminal history doesn't
 * silently delete data.
 *
 * Usage:
 *   npx tsx scripts/nuke-db.ts --confirm
 *
 * Reads `RISKSI_MONGO_URI` from the environment (same var the app uses).
 * Point this at dev ONLY — the user has confirmed this DB is not shared.
 */

import { getDb } from "../src/lib/mongo";

async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error(
      "Refusing to run without --confirm. Re-run as:\n" +
        "  npx tsx scripts/nuke-db.ts --confirm",
    );
    process.exit(2);
  }

  const db = await getDb();
  const collections = await db.listCollections().toArray();
  if (collections.length === 0) {
    console.log("DB is empty. Nothing to drop.");
    process.exit(0);
  }

  console.log(`DB: ${db.databaseName}`);
  console.log(`Dropping ${collections.length} collection(s):`);
  for (const info of collections) {
    const name = info.name;
    try {
      const ok = await db.collection(name).drop();
      console.log(`  - ${name}: ${ok ? "dropped" : "unchanged"}`);
    } catch (err) {
      console.error(`  - ${name}: failed — ${(err as Error).message}`);
    }
  }

  // Explicit exit — getDb() holds a singleton client that keeps the event
  // loop alive.
  process.exit(0);
}

main().catch((err) => {
  console.error("nuke-db failed:", err);
  process.exit(1);
});
