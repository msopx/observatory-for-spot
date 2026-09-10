"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/", label: "Overview" },
  { href: "/ampl", label: "AMPL" },
  { href: "/spot", label: "SPOT" },
  { href: "/broker", label: "Bill Broker" },
  { href: "/lp", label: "LP returns" },
  { href: "/stampl", label: "stAMPL" },
  { href: "/learn", label: "Casebook" },
  { href: "/data", label: "Data" },
] as const;

export function Navigation() {
  const pathname = usePathname();
  const [light, setLight] = useState(false);
  function toggleTheme() {
    const next = !light;
    setLight(next);
    document.documentElement.dataset.theme = next ? "light" : "dark";
  }
  return (
    <header className="site-header">
      <Link className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          ◎
        </span>
        <span>
          <strong>
            Observatory <span className="brand-for">for SPOT</span>
          </strong>
          <small>Unofficial protocol analytics</small>
        </span>
      </Link>
      <nav aria-label="Primary navigation">
        {links.map((link) => (
          <Link
            aria-current={
              pathname.replace(/\/$/, "") === link.href.replace(/\/$/, "")
                ? "page"
                : undefined
            }
            className={
              pathname.replace(/\/$/, "") === link.href.replace(/\/$/, "")
                ? "nav-link active"
                : "nav-link"
            }
            href={link.href}
            key={link.href}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <button
        className="theme-toggle secondary"
        aria-label={light ? "Use dark theme" : "Use light theme"}
        onClick={toggleTheme}
        type="button"
      >
        {light ? "◐" : "◑"}
      </button>
    </header>
  );
}
