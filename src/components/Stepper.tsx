"use client";

import { ReactNode } from "react";

export interface Step {
  id: string;
  title: string;
  subtitle?: string;
}

export function Stepper({
  steps,
  currentIdx,
  onJump,
}: {
  steps: Step[];
  currentIdx: number;
  onJump?: (idx: number) => void;
}) {
  return (
    <ol className="flex overflow-x-auto">
      {steps.map((s, i) => {
        const state =
          i < currentIdx ? "done" : i === currentIdx ? "current" : "upcoming";
        const clickable = onJump && i <= currentIdx;
        return (
          <li key={s.id} className="flex min-w-[156px] flex-1">
            <button
              disabled={!clickable}
              onClick={() => clickable && onJump?.(i)}
              className={`min-w-0 flex-1 text-left transition-colors ${clickable ? "cursor-pointer" : "cursor-default"}`}
            >
              <div className="flex items-center">
                <span
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold ${
                    state === "current"
                      ? "border-accent-500 bg-accent-500 text-white"
                      : state === "done"
                        ? "border-success bg-success text-white"
                        : "border-ink-600 bg-ink-900 text-ink-500"
                  }`}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                {i < steps.length - 1 && (
                  <span className="mx-3 h-px flex-1 bg-ink-700" />
                )}
              </div>
              <div className="mt-3 pr-3">
                <div
                  className={`truncate text-[13px] font-medium ${
                    state === "current"
                      ? "text-accent-400"
                      : state === "done"
                        ? "text-ink-200"
                        : "text-ink-500"
                  }`}
                >
                  {s.title}
                </div>
                <div
                  className={`mt-1 text-[11px] ${
                    state === "current"
                      ? "text-accent-400"
                      : state === "done"
                        ? "text-ink-400"
                        : "text-ink-500"
                  }`}
                >
                  {state === "current" ? "Current" : state === "done" ? "Completed" : "Pending"}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function StepHeading({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-300">
          {eyebrow}
        </div>
        <h2 className="text-[22px] font-semibold text-ink-100">{title}</h2>
        {description && (
          <p className="mt-2 max-w-2xl text-[13px] text-ink-400">{description}</p>
        )}
      </div>
      <div className="flex items-start gap-4">
        <svg
          className="hidden h-7 w-20 text-accent-400 md:block"
          viewBox="0 0 80 28"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 19.5C9.6 19.5 9.6 8.5 17.2 8.5C24.8 8.5 24.8 17.5 32.4 17.5C40 17.5 40 10.5 47.6 10.5C55.2 10.5 55.2 6.5 62.8 6.5C70.4 6.5 70.4 14.5 78 14.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {right}
      </div>
    </div>
  );
}
