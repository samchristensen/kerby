import type { NextConfig } from "next";

const securityHeaders = [
  // No other site may frame the console (clickjacking); scripts stay Next's own, so no script policy is set here.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const config: NextConfig = {
  // TypeScript 7 has no JavaScript API for Next's checker; `make typecheck` checks this workspace with tsc instead.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  reactStrictMode: true,
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
};

export default config;
