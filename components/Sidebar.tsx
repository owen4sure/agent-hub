"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import HelpGuide from "./HelpGuide";

const NAV = [
  { href: "/", label: "Workflows", icon: "◈" },
  { href: "/drafts", label: "草稿 & 範例", icon: "✎" },
  { href: "/schedules", label: "排程 & 執行", icon: "⏰" },
  { href: "/files", label: "產出檔案", icon: "▤" },
  { href: "/settings", label: "設定", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = (localStorage.getItem("theme") as "light" | "dark" | null) ?? null;
    if (stored) {
      document.documentElement.setAttribute("data-theme", stored);
      setTheme(stored);
    } else {
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setTheme(next);
  }

  function isActive(href: string) {
    if (href === "/") return pathname === "/" || pathname.startsWith("/workflows");
    return pathname.startsWith(href);
  }

  return (
    <aside
      className="w-60 shrink-0 flex flex-col border-r h-screen sticky top-0"
      style={{ background: "var(--sidebar-bg)" }}
    >
      <div className="px-5 h-14 flex items-center gap-2 border-b">
        <span className="grid place-items-center w-7 h-7 rounded-lg text-white text-sm font-bold" style={{ background: "var(--accent)" }}>
          A
        </span>
        <span className="font-semibold tracking-tight">Agent Hub</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
              style={{
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-muted)",
                fontWeight: active ? 600 : 500,
              }}
            >
              <span className="w-4 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t space-y-2">
        <HelpGuide />
        <button onClick={toggleTheme} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm muted hover:bg-[var(--surface-2)] transition-colors">
          <span className="w-4 text-center">{theme === "dark" ? "☾" : "☀"}</span>
          {theme === "dark" ? "深色模式" : "淺色模式"}
        </button>
        <p className="text-xs faint px-3">本機自架 · localhost</p>
      </div>
    </aside>
  );
}
