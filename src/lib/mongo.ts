/**
 * Singleton MongoDB client for risksi persistence.
 *
 * Connection string comes from `RISKSI_MONGO_URI` (see `.env.local`). We
 * point at MongoDB Atlas in shared development; the localhost fallback is
 * retained only so a brand-new clone without `.env.local` fails loudly
 * with a clear "can't connect to localhost" rather than a confusing nil.
 *
 * Collections:
 *   - assessments       — full wizard state (input, artifacts, report)
 *   - artifacts         — delta-fetch cache of Glean gathered artifacts
 *   - case_intelligence — per-case Auto Triage cache (summary + precedents)
 *   - events            — usage telemetry for /admin/usage
 *   - lgtm, risks       — review state attached to reports
 */

import { MongoClient, type Db, type Document } from "mongodb";

const MONGO_URI = process.env.RISKSI_MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = "risksi";

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 3_000,
    connectTimeoutMS: 3_000,
  });
  await _client.connect();
  _db = _client.db(DB_NAME);
  return _db;
}

export async function getCollection<T extends Document = Document>(name: string) {
  const db = await getDb();
  return db.collection<T>(name);
}
