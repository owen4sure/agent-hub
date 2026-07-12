"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import HelpGuide from "./HelpGuide";

const NAV = [
  { href: "/", label: "Workflows", icon: "◈" },
  { href: "/drafts", label: "草稿", icon: "✎" },
  { href: "/schedules", label: "排程 & 執行", icon: "⏰" },
  { href: "/runs", label: "執行紀錄", icon: "☰" },
  { href: "/files", label: "產出檔案", icon: "▤" },
  { href: "/settings", label: "設定", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("theme") as "light" | "dark" | null)
      ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  });

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

  return <>
    <aside
      className="w-60 shrink-0 hidden md:flex flex-col border-r h-screen sticky top-0"
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
    <nav
      aria-label="主要導覽"
      className="md:hidden fixed inset-x-0 bottom-0 z-50 h-16 border-t flex items-center justify-around px-1"
      style={{ background: "var(--menu-bg)", backdropFilter: "blur(18px)" }}
    >
      {NAV.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="min-w-0 flex-1 h-full flex flex-col items-center justify-center gap-0.5 text-[10px]"
            style={{ color: active ? "var(--accent)" : "var(--text-muted)", fontWeight: active ? 650 : 500 }}
          >
            <span aria-hidden="true" className="text-base leading-none">{item.icon}</span>
            <span className="truncate max-w-full px-1">{item.label.replace(" & ", "/")}</span>
          </Link>
        );
      })}
    </nav>
  </>;
}
