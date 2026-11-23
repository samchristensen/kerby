import type { Metadata } from "next";
import { getSession } from "../../_lib/session.ts";
import { SignUpForm } from "./form.tsx";

export const metadata: Metadata = { title: "Create a workspace" };

// Not a redirect when signed in: signing up signs in, and the form must survive that to show the new API key once.
export default async function SignUpPage() {
  const signedIn = (await getSession()) !== undefined;
  return <SignUpForm signedIn={signedIn} />;
}
