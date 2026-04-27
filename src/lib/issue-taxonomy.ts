/**
 * MongoDB Support case issue taxonomy.
 *
 * A compact, stable set of categories that both the Auto Triage prompts and
 * the Risk Register synthesis reference. The ids are used verbatim in prompt
 * output (JSON / inline tags) so downstream aggregation and the Risk Register
 * tech-area breakdown can group findings reliably.
 *
 * Ordering roughly mirrors the surface-area taxonomy (connectivity → auth →
 * drivers → query → schema → indexing → writes → replication → sharding →
 * storage → system → backup → upgrades → Atlas → security → observability →
 * Ops Manager → k8s → Realm/Device Sync → specialized → integrity → licensing
 * → how-to → tooling → process).
 */

export interface TaxonomyCategory {
  /** Kebab-case slug. Stable — referenced in prompt output and matched in synthesis. */
  id: string;
  /** Display name for the Risk Register breakdown table. */
  name: string;
  /** A handful of short sub-examples used to guide the LLM's classification. */
  examples: string[];
}

export const ISSUE_TAXONOMY: readonly TaxonomyCategory[] = [
  { id: "connectivity",         name: "Connectivity & Networking",         examples: ["DNS SRV", "TLS handshake", "Atlas IP access list", "VPC peering / PrivateLink", "connection timeout", "LB idle-timeout drops"] },
  { id: "authentication",       name: "Authentication & Authorization",   examples: ["SCRAM-SHA mismatch", "LDAP/AD bind", "x.509 client cert", "AWS IAM auth", "OIDC", "role privileges", "authSource"] },
  { id: "drivers",              name: "Drivers & Client Applications",    examples: ["pool sizing (maxPoolSize)", "serverSelectionTimeoutMS", "retryable reads/writes", "read/write concern", "session misuse", "cursor leaks", "BSON/Decimal128"] },
  { id: "query-performance",    name: "Query Performance",                examples: ["missing index / COLLSCAN", "non-ESR index", "large $in", "$lookup without index", "unbounded $sort in memory", "plan cache thrash", "regex anchoring"] },
  { id: "schema",               name: "Schema & Data Modeling",           examples: ["unbounded array", "16 MB doc limit", "bad shard key (hotspot / monotonic)", "schema drift", "inconsistent field types", "time-series granularity"] },
  { id: "indexing",             name: "Indexing Operations",              examples: ["index build OOM / foreground", "TTL lag", "too many indexes (write amp)", "index size > RAM", "rolling builds", "duplicate-key on unique"] },
  { id: "write-concurrency",    name: "Write Operations & Concurrency",   examples: ["WriteConflict", "E11000 duplicate key", "findAndModify hotspot", "transaction retry / TransientTxn", "bulk write ordered/unordered"] },
  { id: "replication",          name: "Replication",                      examples: ["replication lag", "oplog rollover", "initial sync", "rollback after unclean failover", "arbiter (PSA) pitfalls", "election tuning"] },
  { id: "sharding",             name: "Sharding",                         examples: ["chunk migration failure", "jumbo chunk", "orphaned docs", "mongos stale routing", "zone sharding", "scatter-gather queries"] },
  { id: "storage-engine",       name: "Storage Engine (WiredTiger)",      examples: ["cache pressure / eviction", "dirty bytes threshold", "checkpoint stalls", "history store growth", "journal latency", "compact"] },
  { id: "system-resources",     name: "Memory, CPU, Disk, OS",            examples: ["OOM kill", "THP not disabled", "ulimit nofile", "disk I/O saturation", "IOPS/gp2 burst", "disk/inode full", "NUMA", "CPU steal"] },
  { id: "backup-restore",       name: "Backup & Restore",                 examples: ["mongodump/restore version mismatch", "--oplog consistency", "Atlas snapshot/PIT restore", "cross-region restore", "queryable backup"] },
  { id: "upgrades",             name: "Upgrades & Migrations",            examples: ["FCV ordering", "rolling upgrade sequence", "mongosync / Live Migration", "Relational Migrator", "driver/server compat", "deprecated commands"] },
  { id: "atlas-platform",       name: "Atlas Platform",                   examples: ["cluster tier / auto-scaling", "Atlas Search / mongot", "Vector Search tuning", "Stream Processing", "Data Federation", "Private Endpoint DNS", "Admin API rate limits"] },
  { id: "security-compliance",  name: "Security & Compliance",            examples: ["encryption at rest / BYOK / KMS", "CSFLE / Queryable Encryption", "audit log / PII redaction", "FedRAMP/HIPAA/PCI", "credential leakage"] },
  { id: "monitoring",           name: "Monitoring & Observability",       examples: ["Atlas metrics gaps", "FTDC sampling", "alerts noisy/silent", "slow query log / profiler", "3rd-party (Datadog/Prometheus) integration"] },
  { id: "ops-manager",          name: "Ops Manager / Cloud Manager",      examples: ["automation agent not reporting", "backup daemon disk full", "head DB corruption", "deployment plan stuck", "HA/failover"] },
  { id: "kubernetes",           name: "Kubernetes / Operator",            examples: ["StatefulSet identity", "PVC / storage class", "CRD upgrade", "multi-cluster", "probes false-restart"] },
  { id: "realm-device-sync",    name: "Realm / Device Sync / App Services", examples: ["sync client reset", "schema migration on mobile", "function timeouts", "trigger ordering", "permissions evaluation"] },
  { id: "specialized-workloads", name: "Specialized Workloads",           examples: ["time-series limits", "change stream resumability", "GridFS", "$graphLookup depth", "geospatial at antimeridian"] },
  { id: "data-integrity",       name: "Data Integrity & Corruption",      examples: ["validate errors", "silent divergence across members", "checksum failures", "--repair risk", "split-brain"] },
  { id: "licensing-commercial", name: "Licensing & Commercial",           examples: ["SSPL vs Enterprise", "entitlement / feature gating", "support plan coverage", "reserved / commitment pricing"] },
  { id: "how-to-best-practices", name: "Documentation / How-To / Best Practices", examples: ["connection string construction", "role/privilege design", "index design", "capacity planning", "DR architecture"] },
  { id: "tooling",              name: "Tooling Ecosystem",                examples: ["mongosh vs legacy shell", "Compass", "mongoimport/export CSV types", "mongostat interpretation", "Kafka/Spark connector", "BI Connector"] },
  { id: "support-process",      name: "Support Process / Meta",           examples: ["severity escalation", "engineer handoff/timezone", "SLA interpretation", "RCA follow-up", "architecture review request"] },
] as const;

/**
 * Compact taxonomy listing suitable for injection into an Auto Triage prompt.
 * Each line: `- <id> — <name>: <ex1>, <ex2>, <ex3>`. Kept under ~150 tokens.
 */
export function taxonomyPromptBlock(): string {
  return ISSUE_TAXONOMY.map(
    (c) =>
      `- \`${c.id}\` — ${c.name}: ${c.examples.slice(0, 3).join("; ")}`,
  ).join("\n");
}

/** All valid category ids — used to tighten regex extraction in downstream code. */
export const TAXONOMY_IDS: readonly string[] = ISSUE_TAXONOMY.map((c) => c.id);

/** Look up a category by id. Returns undefined for unknown ids. */
export function getCategory(id: string): TaxonomyCategory | undefined {
  return ISSUE_TAXONOMY.find((c) => c.id === id);
}
