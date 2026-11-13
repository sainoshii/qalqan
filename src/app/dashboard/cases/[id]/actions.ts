"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/cases/repository";
import { isDashboardAuthorized } from "@/lib/dashboard/auth";
import { updateStatus } from "@/lib/dashboard/queries";
import { CASE_STATUSES, type CaseStatus } from "@/lib/domain";

/**
 * Смена статуса случая аналитиком. Серверная функция — публичная точка входа,
 * поэтому доступ и вход проверяются здесь же, а не только в proxy.
 */
export async function changeStatus(formData: FormData) {
  if (!isDashboardAuthorized((await headers()).get("authorization"))) throw new Error("Нет доступа к панели");

  const id = formData.get("id");
  const status = formData.get("status");
  if (typeof id !== "string" || id.length > 100 || !(CASE_STATUSES as readonly unknown[]).includes(status)) {
    throw new Error("Некорректный запрос");
  }

  const result = await updateStatus(await db(), id, status as CaseStatus);
  const path = `/dashboard/cases/${encodeURIComponent(id)}`;
  revalidatePath("/dashboard");
  revalidatePath(path);
  redirect(result === "ok" ? path : `${path}?error=${result}`);
}
