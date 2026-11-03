"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { isTicketStatus, updateTicketStatus } from "@/lib/tickets";

/** Mark a ticket open / fixed / ignored, optionally with a note. */
export async function setTicketStatus(formData: FormData): Promise<void> {
  await requireSession();
  const id = Number.parseInt(String(formData.get("id") ?? ""), 10);
  const status = String(formData.get("status") ?? "");
  const noteRaw = formData.get("note");
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim().slice(0, 2000) : null;
  const back = String(formData.get("back") ?? "/tickets");
  if (!Number.isFinite(id) || !isTicketStatus(status)) redirect(back);
  await updateTicketStatus(id, status, note);
  revalidatePath("/tickets");
  revalidatePath(`/tickets/${id}`);
  redirect(back.startsWith("/") ? back : "/tickets");
}
