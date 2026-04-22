"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import CommandPaletteToggle from "@/components/CommandPaletteToggle";

const NAV_ITEMS = [
  { href: "/", label: "Risk Register", exact: true },
  { href: "/reports", label: "Reports" },
  { href: "/admin/usage", label: "Usage" },
  { href: "/settings", label: "Settings" },
];

export default function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 text-[13px]">
      {NAV_ITEMS.map((item) => {
        const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "px-3 py-2 transition-colors",
              isActive
                ? "text-ink-100 font-medium"
                : "text-ink-400 hover:text-ink-100",
            ].join(" ")}
            style={{ borderRadius: "6px" }}
          >
            {item.label}
          </Link>
        );
      })}
      <CommandPaletteToggle />
    </nav>
  );
}
