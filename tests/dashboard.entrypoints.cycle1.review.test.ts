import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { getCase } from "@/lib/dashboard/queries";
import CasePage from "@/app/dashboard/cases/[id]/page";
import { changeStatus } from "@/app/dashboard/cases/[id]/actions";

const mocks = vi.hoisted(() => ({ headers: vi.fn(), db: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/lib/cases/repository", () => ({ db: mocks.db }));

let database: ReturnType<typeof createDb>;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("QALQAN_DASHBOARD_PASSWORD", "review-secret");
  mocks.headers.mockResolvedValue(new Headers());
  database = createDb(":memory:");
  await migrate(database);
  mocks.db.mockResolvedValue(database);
  await database.execute(`INSERT INTO cases (id, created_at, client_alias, channel, language, text_excerpt,
    risk_score, analysis_mode, outcome) VALUES ('known', '2026-11-13T00:00:00.000Z', 'Synthetic',
    'sms', 'ru', '[КОД]', 80, 'rules', 'no_transfer')`);
});
afterEach(() => { database.close(); vi.unstubAllEnvs(); });

function form(id = "known", status = "reviewing") {
  const f = new FormData(); f.set("id", id); f.set("status", status); return f;
}
function authorize() {
  mocks.headers.mockResolvedValue(new Headers({ authorization: `Basic ${Buffer.from("analyst:review-secret").toString("base64")}` }));
}
// Execute the real async child of the Suspense boundary, with Next request APIs mocked.
async function caseData(id: string, error?: string) {
  const props = { params: Promise.resolve({ id }), searchParams: Promise.resolve({ error }) };
  const boundary = CasePage(props);
  const child = boundary.props.children as ReactElement<typeof props>;
  const render = child.type as (props: typeof child.props) => Promise<ReactNode>;
  return render(child.props);
}

describe("dashboard review: server action without proxy", () => {
  it.each([null, "Basic ", "Basic !!!", `Basic ${Buffer.from("analyst:wrong").toString("base64")}`])("denies direct invocation with %s before opening the database", async (authorization) => {
    mocks.headers.mockResolvedValue(new Headers(authorization ? { authorization } : {}));
    await expect(changeStatus(form())).rejects.toThrow("Нет доступа");
    expect(mocks.db).not.toHaveBeenCalled();
    expect((await getCase(database, "known"))?.status).toBe("new");
  });
  it("authorizes a valid request, updates status and invalidates both pages", async () => {
    authorize();
    await expect(changeStatus(form())).rejects.toThrow("REDIRECT:/dashboard/cases/known");
    expect((await getCase(database, "known"))?.status).toBe("reviewing");
    expect(mocks.revalidate.mock.calls).toEqual([["/dashboard"], ["/dashboard/cases/known"]]);
  });
  it("demo mode permits changes when password is unset", async () => {
    vi.stubEnv("QALQAN_DASHBOARD_PASSWORD", "");
    await expect(changeStatus(form())).rejects.toThrow("REDIRECT:/dashboard/cases/known");
    expect((await getCase(database, "known"))?.status).toBe("reviewing");
  });
  it.each([form("known", "bogus"), form("a".repeat(101)), new FormData()])("validates input before database access", async (input) => {
    authorize();
    await expect(changeStatus(input)).rejects.toThrow("Некорректный запрос");
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("reports forbidden transitions and missing IDs without mutation", async () => {
    authorize();
    await expect(changeStatus(form("known", "new"))).rejects.toThrow("?error=invalid");
    await expect(changeStatus(form("missing"))).rejects.toThrow("?error=not_found");
    expect((await getCase(database, "known"))?.status).toBe("new");
  });
});

describe("dashboard review: case page inputs", () => {
  it("renders a known case with an ordinary unknown error query", async () => {
    expect(renderToStaticMarkup(await caseData("known", "unknown"))).toContain("[КОД]");
  });
  it("unknown ID produces notFound", async () => {
    await expect(caseData("missing")).rejects.toThrow("NOT_FOUND");
  });
  it("C1: a URL-encoded percent in an unknown ID produces notFound, not URIError", async () => {
    // Next already decodes /dashboard/cases/%25 to params.id = '%'.
    await expect(caseData("%")).rejects.toThrow("NOT_FOUND");
  });
  it("C2: unknown error query values cannot become React children via Object.prototype", async () => {
    const content = await caseData("known", "__proto__");
    expect(() => renderToStaticMarkup(content)).not.toThrow();
  });
});
