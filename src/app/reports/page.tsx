"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { parseRiskRating, ratingChipClasses } from "@/lib/parse-risk-rating";

interface AccountRow {
  _id: string;
  updatedAt: string;
  artifactCount: number;
  hasReport: boolean;
  salesforceId?: string;
  canonicalName?: string;
  report?: string;
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
                    <th className="text-left pb-3 pr-4 font-medium">Risk</th>
                    <th className="text-left pb-3 pr-4 font-medium">Last updated</th>
                    <th className="text-left pb-3 pr-4 font-medium">Artifacts</th>
                    <th className="text-left pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {withReport.map((a) => {
                    const hubUrl = a.salesforceId
                      ? `https://hub.corp.mongodb.com/account/${a.salesforceId}/overview`
                      : null;
                    const rating = parseRiskRating(a.report);
                    const ratingCls = ratingChipClasses(rating);
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
                        <td className="py-3 pr-4">
                          {rating ? (
                            <span
                              className={`inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 border ${ratingCls.bg} ${ratingCls.border} ${ratingCls.text}`}
                              style={{ borderRadius: "999px" }}
                              title={ratingCls.label}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${ratingCls.dot}`} />
                              {rating}
                            </span>
                          ) : (
                            <span className="text-ink-600 text-[10px]">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-ink-500 text-xs whitespace-nowrap">
                          {new Date(a.updatedAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </td>
                        <td className="py-3 pr-4 text-ink-500 text-xs tabular-nums">
                          {a.artifactCount ?? "—"}
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-3 text-xs">
                            {a.salesforceId ? (
                              <Link
                                href={`/reports/${encodeURIComponent(a.salesforceId)}`}
                                className="text-accent-500 hover:underline"
                              >
                                View report →
                              </Link>
                            ) : (
                              <span className="text-ink-600" title="No Salesforce ID recorded for this report">
                                View report —
                              </span>
                            )}
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
