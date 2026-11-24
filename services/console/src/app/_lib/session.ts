// The session cookie. It holds a random token the console stores only as a hash (packages/control-plane); it is
// HttpOnly, SameSite=Lax and, off localhost, Secure. Server actions are POSTs whose Origin Next.js checks.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { ChatAccess, Session } from "../../types/index.ts";
import { CLIENT_ADDRESS_HEADER, consoleService, secureCookies } from "./console.ts";

const COOKIE = "kerby_session";

/** The signed-in person for this request, or undefined. Looked up once per request. */
export const getSession = cache(async (): Promise<Session | undefined> => {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? consoleService().session(token) : undefined;
});

/**
 * The session, or a redirect to the sign-in page. Every dashboard page and every action calls it: a layout is not
 * rendered again when the client navigates between its pages, so its check alone protects nothing.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * The session with its token, for calls that go through the api (chat). The token is the cookie's value and stays on
 * the server: it is never put in a prop of a client component or in a response body.
 */
export async function getChatAccess(): Promise<ChatAccess | undefined> {
  const session = await getSession();
  const token = (await cookies()).get(COOKIE)?.value;
  return session && token ? { session, token } : undefined;
}

/** `getChatAccess`, or a redirect to the sign-in page: for pages and actions. */
export async function requireChatAccess(): Promise<ChatAccess> {
  const access = await getChatAccess();
  if (!access) redirect("/login");
  return access;
}

export async function startSession(token: string, expiresAt: string): Promise<void> {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

/** Forget the session on both sides. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await consoleService().logOut(token);
  jar.delete(COOKIE);
}

/** The client's address, for the sign-in limits. */
export async function clientAddress(): Promise<string> {
  return (await headers()).get(CLIENT_ADDRESS_HEADER) ?? "unknown";
}
