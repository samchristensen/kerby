import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "../../_lib/session.ts";
import { LogInForm } from "./form.tsx";

export const metadata: Metadata = { title: "Sign in" };

export default async function LogInPage() {
  if (await getSession()) redirect("/dashboard");
  return <LogInForm />;
}
