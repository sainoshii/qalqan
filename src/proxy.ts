import { NextResponse, type NextRequest } from "next/server";
import { DASHBOARD_REALM, isDashboardAuthorized } from "./lib/dashboard/auth";

/** Пароль на панель антифрода (если задан QALQAN_DASHBOARD_PASSWORD). */
export function proxy(request: NextRequest) {
  if (isDashboardAuthorized(request.headers.get("authorization"))) return NextResponse.next();
  return new NextResponse("Требуется вход в панель антифрода", {
    status: 401,
    headers: { "WWW-Authenticate": DASHBOARD_REALM, "Cache-Control": "no-store" },
  });
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
