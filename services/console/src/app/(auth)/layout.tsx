// No signed-in redirect here: the sign-up action sets the session cookie, the route then renders again, and a
// redirect would throw away the API key the success state shows once. Each page decides instead.
import type { ReactNode } from "react";
import { Logo } from "../_components/ui.tsx";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12">
      <Logo href="/" />
      <div className="mt-8 w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
