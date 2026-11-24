import type { ReactNode } from "react";
import { Logo } from "../_components/ui.tsx";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-page px-4 py-12">
      <Logo href="/" />
      <div className="mt-8 w-full max-w-md rounded-2xl border border-line bg-panel p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
