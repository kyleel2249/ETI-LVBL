import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const NAV = [
  { to: "/", label: "Markets" },
  { to: "/paper", label: "Paper & Risk" },
  { to: "/providers", label: "Providers" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-8 px-4">
          <Link to="/" className="flex items-baseline gap-2">
            <span className="num text-lg font-bold tracking-tight text-primary">ETI</span>
            <span className="label-caps hidden sm:inline">Elite Trading Intelligence</span>
          </Link>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} activeOptions={{ exact: n.to === "/" }}
                className="rounded-sm px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground">
                {n.label}
              </Link>
            ))}
          </nav>
          <span className="label-caps ml-auto hidden md:inline">Research & paper trading only · not financial advice</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6">{children}</main>
    </div>
  );
}

export function Panel({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="label-caps">{title}</h2>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Delta({ v, suffix = "%" }: { v: number | null | undefined; suffix?: string }) {
  if (v == null || !Number.isFinite(v)) return <span className="num text-muted-foreground">—</span>;
  return <span className={`num ${v >= 0 ? "text-bull" : "text-bear"}`}>{v >= 0 ? "+" : ""}{v.toFixed(2)}{suffix}</span>;
}

export function StatusDot({ state }: { state: "ok" | "warn" | "down" | "off" }) {
  const c = { ok: "bg-bull live-dot", warn: "bg-warn live-dot", down: "bg-bear", off: "bg-muted-foreground" }[state];
  return <span className={`inline-block h-2 w-2 rounded-full ${c}`} />;
}
