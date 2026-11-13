import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as React from "react";
import { BankDemo } from "@/components/bank/BankDemo";
import { SCENARIOS } from "@/components/bank/scenarios";

// Handler-level checks only: no DOM, effects, React scheduling or network.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = hooks.cursor++;
    if (!(i in hooks.cells)) hooks.cells[i] = initial;
    return [hooks.cells[i], (next: unknown) => {
      hooks.cells[i] = typeof next === "function" ? next(hooks.cells[i]) : next;
    }];
  },
  useRef(initial: unknown) {
    const i = hooks.cursor++;
    if (!(i in hooks.cells)) hooks.cells[i] = { current: initial };
    return hooks.cells[i];
  },
  useEffect() {},
}));
type Element = React.ReactElement<Record<string, unknown>>;
function nodes(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function content(node: unknown): string {
  if (Array.isArray(node)) return node.map(content).join("");
  if (React.isValidElement<Record<string, unknown>>(node)) return content(node.props.children);
  return typeof node === "string" ? node : "";
}
function render() {
  hooks.cursor = 0;
  const tree = BankDemo();
  return {
    text: content(tree),
    control(type: string, label = "") {
      const result = nodes(tree).find((n) => n.type === type && content(n).includes(label));
      if (!result) throw new Error(`Missing control: ${type} ${label}`);
      return result;
    },
  };
}
function invoke(element: Element, name: string, event?: unknown) {
  return (element.props[name] as (event?: unknown) => unknown)(event);
}
const edit = (value: string) => invoke(render().control("textarea"), "onChange", { target: { value } });
const check = () => invoke(render().control("button", "Проверить текст"), "onClick");
const pick = () => invoke(render().control("button", SCENARIOS[0].title), "onClick");
let requests: { body: { text: string }; resolve: (response: Response) => void }[];
async function respond(index: number, recommendation: string, status = 200) {
  requests[index].resolve(Response.json(status === 200 ? {
    riskScore: 0, scamType: null, reasons: [], recommendation, mode: "rules",
  } : { error: recommendation }, { status }));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  requests = [];
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ body: JSON.parse(String(init.body)), resolve });
  }));
});
afterEach(() => vi.unstubAllGlobals());

it.each([200, 503])("C3: old response (%i) cannot finish the new custom-text analysis", async (status) => {
  pick();
  edit("Новый текст");
  expect(render().text).not.toContain("Проверяем…");
  expect(render().control("button", "Проверить текст").props.disabled).toBe(false);
  const pending = check();
  expect(requests[1].body.text).toBe("Новый текст");
  await respond(0, "STALE_RESPONSE", status);
  expect(render().text).not.toContain("STALE_RESPONSE");
  expect(render().text).toContain("Проверяем…");
  expect(render().control("button", "Проверить текст").props.disabled).toBe(true);
  await respond(1, "CURRENT_RESPONSE");
  await pending;
  expect(render().text).toContain("CURRENT_RESPONSE");
  expect(render().text).not.toContain("Проверяем…");
  edit("Следующий текст");
  expect(render().text).not.toContain("CURRENT_RESPONSE");
});

it.each(["", "   "])("C3: clearing to %j invalidates pending analysis and disables checking", async (value) => {
  edit("Исходный текст");
  const pending = check();
  edit(value);
  expect(render().control("button", "Проверить текст").props.disabled).toBe(true);
  expect(render().text).not.toContain("Проверяем…");
  // Exercise the empty-input guard as well as the disabled button state.
  await check();
  expect(requests).toHaveLength(1);
  await respond(0, "STALE_RESPONSE");
  await pending;
  expect(render().text).not.toContain("STALE_RESPONSE");
});

it("scenario selection supersedes a pending custom-text check", async () => {
  edit("Свой текст");
  const pending = check();
  pick();
  expect(render().control("textarea").props.value).toBe("");
  expect(requests[1].body.text).toBe(SCENARIOS[0].text);
  await respond(1, "SCENARIO_RESPONSE");
  await respond(0, "STALE_RESPONSE");
  await pending;
  expect(render().text).toContain("SCENARIO_RESPONSE");
  expect(render().text).not.toContain("STALE_RESPONSE");
});
