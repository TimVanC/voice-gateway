"use server";

import { redirect } from "next/navigation";
import { checkPassword, clearSessionCookie, setSessionCookie } from "@/lib/auth";

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  if (!password || !checkPassword(password)) {
    redirect("/login?error=1");
  }
  await setSessionCookie();
  redirect("/");
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
