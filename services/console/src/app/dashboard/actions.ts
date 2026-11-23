"use server";
import { redirect } from "next/navigation";
import { endSession } from "../_lib/session.ts";

export async function logOutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
