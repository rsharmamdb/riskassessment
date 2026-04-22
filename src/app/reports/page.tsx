"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui";

interface AccountRow {
  _id: string;
  updatedAt: string;
  artifactCount: number;
  hasReport: boolean;
  salesforceId?: string;
  canonicalName?: string;
}

export default function ReportsIndexPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/db/assessments")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setAccounts(j.assessments ?? []);
        else setError(j.error ?? "Failed to load");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-ink-400 text-sm py-16 text-center">Loading saved reports…</div>;
  }
  if (error) {
    return (
      <div className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger" style={{ borderRadius: '8px' }}>
        {error}
      </div>
    );
  }

  const withReport = accounts.filter((a) => a.hasReport);
  const stale = withReport.filter(
    (a) => Date.now() - new Date(a.updatedAt).getTime() > 30 * 24 * 60 * 60 * 1000,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Saved Reports</h1>
          <p className="text-sm text-ink-500 mt-1">
            {withReport.length} report{withReport.length !== 1 ? "s" : ""} across {withReport.length} account{withReport.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/"
          className="text-sm text-accent-400 hover:text-accent-300 transition-colors"
        >
          + New report
        </Link>
      </div>

      {stale.length > 0 && (
        <div className="border border-warn/35 bg-warn/10 px-4 py-3 text-sm text-warn" style={{ borderRadius: '8px' }}>
          ⚑ {stale.length} account{stale.length !== 1 ? "s have" : " has"} not been refreshed in 30+ days:{" "}
          {stale.map((a) => a.canonicalName || a._id).join(", ")}
        </div>
      )}

      <Card>
        <CardHeader title="All accounts" />
        <CardBody>
          {withReport.length === 0 ? (
            <div className="text-ink-500 text-sm py-4 text-center">
              No generated reports yet.{" "}
              <Link href="/" className="text-accent-500 hover:underline">Start one →</Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-ink-500 text-xs">
                    <th className="text-left pb-3 pr-4 font-medium">Account</th>
                    <th className="text-left pb-3 pr-4 font-medium">Last updated</th>
                    <th className="text-left pb-3 pr-4 font-medium">Artifacts</th>
                    <th className="text-left pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {withReport.map((a) => {
                    const isStale =
                      Date.now() - new Date(a.updatedAt).getTime() > 30 * 24 * 60 * 60 * 1000;
                    const hubUrl = a.salesforceId
                      ? `https://hub.corp.mongodb.com/account/${a.salesforceId}/overview`
                      : null;
                    return (
                      <tr key={a._id} className="border-b border-ink-800/50 hover:bg-ink-900">
                        <td className="py-3 pr-4 font-medium text-ink-100">
                          {hubUrl ? (
                            <a
                              href={hubUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent-500 hover:underline capitalize"
                            >
                              {a.canonicalName || a._id}
                            </a>
                          ) : (
                            <span className="capitalize">{a.canonicalName || a._id}</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-ink-500 text-xs whitespace-nowrap">
                          {new Date(a.updatedAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          {isStale && (
                            <span className="ml-2 text-warn">⚑ stale</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-ink-500 text-xs tabular-nums">
                          {a.artifactCount ?? "—"}
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-3 text-xs">
                            <Link
                              href={`/reports/${encodeURIComponent(a._id)}`}
                              className="text-accent-500 hover:underline"
                            >
                              View report →
                            </Link>
                            <Link
                              href={`/?account=${encodeURIComponent(a._id)}`}
                              className="text-ink-500 hover:text-ink-300 hover:underline"
                            >
                              Edit in wizard
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
