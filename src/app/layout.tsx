import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Navigation } from "../components/navigation";
import {
  RELEASE_TAG,
  RELEASE_TREE_URL,
  SOURCE_ARCHIVE_PATH,
} from "../lib/repository";
import "./globals.css";

export const metadata: Metadata = {
  title: "Observatory for SPOT — Unofficial Analytics",
  description: "Unofficial analytics for AMPL, SPOT, and Bill Broker.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <Navigation />
        <main className="page-shell" id="main-content">
          {children}
        </main>
        <footer className="site-footer">
          Unofficial, best-effort protocol analytics · informational only · no
          warranty ·{" "}
          <a href="/TRADEMARKS.txt">Names &amp; affiliation</a> ·{" "}
          <a href="/LICENSE.txt">GPL-3.0-or-later license</a> ·{" "}
          <a href="/THIRD-PARTY-NOTICES.txt">Third-party notices</a> ·{" "}
          <a href={RELEASE_TREE_URL} rel="noreferrer" title={RELEASE_TAG}>
            Source
          </a>{" "}
          ·{" "}
          <a href={SOURCE_ARCHIVE_PATH} download>
            Source archive
          </a>
        </footer>
      </body>
    </html>
  );
}
