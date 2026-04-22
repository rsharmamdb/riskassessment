"use client";

/** Clicking triggers ⌘K via a synthetic keyboard event so CommandPalette opens. */
export default function CommandPaletteToggle() {
  function open() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  }
  return (
    <button
      onClick={open}
      aria-label="Open command palette"
      className="ml-1 flex items-center gap-1.5 border border-ink-700 px-3 py-2 text-xs text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-100"
      style={{ borderRadius: "9999px" }}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
      </svg>
      <kbd className="font-mono">⌘K</kbd>
    </button>
  );
}
