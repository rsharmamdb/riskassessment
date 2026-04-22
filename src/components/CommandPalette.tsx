"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { exportPdfForAccount } from "@/lib/pdf-export";

interface Action {
  id: string;
  label: string;
  keywords?: string;
  hint?: string;
  run: () => void | Promise<void>;
}

const STATIC_ACTIONS: Omit<Action, "run">[] = [
  { id: "go-home", label: "Go to Risk Register", hint: "/ (home)", keywords: "wizard home new account" },
  { id: "go-reports", label: "Go to Reports", hint: "/reports", keywords: "reports all accounts list" },
  { id: "go-usage", label: "Go to Usage dashboard", hint: "/admin/usage", keywords: "usage dashboard admin analytics" },
  { id: "go-settings", label: "Go to Settings", hint: "/settings", keywords: "settings config token model" },
  { id: "print", label: "Export current report PDF", hint: "/api/export/pdf", keywords: "pdf download export report" },
];

export default function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);

  // Build full action list (static + dynamic based on current accounts)
  const actions: Action[] = [
    ...STATIC_ACTIONS.map((a) => ({
      ...a,
      run: () => {
        if (a.id === "go-home") router.push("/");
        else if (a.id === "go-reports") router.push("/reports");
        else if (a.id === "go-usage") router.push("/admin/usage");
        else if (a.id === "go-settings") router.push("/settings");
        else if (a.id === "print") {
          if (!pathname.startsWith("/reports/")) {
            throw new Error("Open a saved report page before exporting PDF.");
          }
          const accountName = decodeURIComponent(pathname.replace(/^\/reports\//, ""));
          return exportPdfForAccount(accountName);
        }
      },
    })),
  ];

  const filtered = actions.filter((a) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      a.label.toLowerCase().includes(q) ||
      (a.keywords ?? "").toLowerCase().includes(q)
    );
  });

  // ⌘K / Ctrl+K to open
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setSelected(0);
      }
      if (open && e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const runAction = useCallback(
    async (a: Action) => {
      setOpen(false);
      try {
        await a.run();
      } catch (error) {
        window.alert((error as Error).message);
      }
    },
    [],
  );

  // Keyboard navigation
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      const a = filtered[selected];
      if (a) runAction(a);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] px-4"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[#05070f]/70 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative w-full max-w-lg overflow-hidden border border-ink-700 bg-ink-800 shadow-menu"
        style={{ borderRadius: "8px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-ink-700 px-4">
          <svg className="w-4 h-4 text-ink-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search actions…"
            className="flex-1 bg-transparent py-4 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
          <kbd className="border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-xs text-ink-500" style={{ borderRadius: "6px" }}>esc</kbd>
        </div>

        {/* Results */}
        <ul className="py-2 max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-ink-500">No matching actions</li>
          ) : (
            filtered.map((a, i) => (
              <li key={a.id}>
                <button
                  className={`w-full flex items-center justify-between gap-4 px-4 py-2.5 text-sm transition-colors ${
                    selected === i ? "bg-accent-500/10 text-ink-100" : "text-ink-200 hover:bg-ink-900"
                  }`}
                  onClick={() => runAction(a)}
                  onMouseEnter={() => setSelected(i)}
                >
                  <span>{a.label}</span>
                  {a.hint && (
                    <span className="text-xs text-ink-500 font-mono flex-shrink-0">{a.hint}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>

        {/* Footer hint */}
          <div className="flex items-center gap-4 border-t border-ink-700 px-4 py-2 text-xs text-ink-500">
            <span><kbd className="border border-ink-700 bg-ink-900 px-1 font-mono" style={{ borderRadius: "6px" }}>↑↓</kbd> navigate</span>
            <span><kbd className="rounded border border-ink-700 bg-ink-900 px-1 font-mono">↵</kbd> open</span>
            <span><kbd className="rounded border border-ink-700 bg-ink-900 px-1 font-mono">esc</kbd> close</span>
          <span className="ml-auto opacity-60">⌘K to toggle</span>
        </div>
      </div>
    </div>
  );
}
