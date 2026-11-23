import type { Metadata, Viewport } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kerby", template: "%s · Kerby" },
  description: "Durable agents on your own model keys: a multi-tenant agent runtime.",
};

// The page background (--op-night in tokens.css) tints the browser chrome on mobile.
export const viewport: Viewport = { themeColor: "#14161d" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        {children}
        <Script src="/operator-mascot.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
