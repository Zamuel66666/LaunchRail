import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  description: "A self-hosted platform for health-checked application deployments.",
  title: "LaunchRail",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Link className="skip-link" href="#main-content">
          Skip to main content
        </Link>
        {children}
      </body>
    </html>
  );
}
