import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { BankDemo } from "@/components/bank/BankDemo";
import { SCENARIOS } from "@/components/bank/scenarios";
import type { AnalysisResult } from "@/lib/domain";

// Handler-level harness: no DOM dependencies or network. State/ref values persist
// between explicit renders. Effects, browser focus and React scheduling are NOT tested.
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
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function content(node: unknown): string {
  if (Array.isArray(node)) return node.map(content).join("");
  if (React.isValidElement<Record<string, unknown>>(node)) return content(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render() {
  hooks.cursor = 0;
  const tree = BankDemo();
  const nodes = elements(tree);
  const find = (predicate: (element: Element) => boolean) => {
    const result = nodes.find(predicate);
    if (!result) throw new Error("Expected control not found");
    return result;
  };
  return {
    tree, nodes,
    button: (label: string) => find((n) => n.type === "button" && content(n).includes(label)),
    textarea: () => find((n) => n.type === "textarea"),
    form: () => find((n) => n.type === "form"),
  };
}
function invoke(element: Element, name: string, event?: unknown) {
  return (element.props[name] as (event?: unknown) => unknown)(event);
}
const benign: AnalysisResult = {
  riskScore: 0, scamType: null, reasons: [], recommendation: "BENIGN_RESULT",
  mode: "rules",
};
const scam: AnalysisResult = {
  riskScore: 100, scamType: "safe_account", reasons: ["SCAM_REASON"],
  recommendation: "SCAM_RESULT", mode: "rules",
};
type Pending = { url: string; body: Record<string, unknown>; resolve: (response: Response) => void };
let requests: Pending[];
async function respond(index: number, body: unknown) {
  requests[index].resolve(Response.json(body));
  // Drain fetch and response.json promises without timers or network.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  requests = [];
  vi.stubGlobal("React", React); // Also support Vitest's classic JSX transform.
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ url, body: JSON.parse(String(init.body)), resolve });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("stage 3 cycle 2: analysis response ownership", () => {
  it("keeps the latest scenario result when requests resolve out of order", async () => {
    invoke(render().button(SCENARIOS[0].title), "onClick");
    invoke(render().button(SCENARIOS[4].title), "onClick");
    await respond(1, benign);
    await respond(0, scam);
    expect(content(render().tree)).toContain("BENIGN_RESULT");
    expect(content(render().tree)).not.toContain("SCAM_RESULT");
  });

  it("C3: discards an analysis response after the user replaces the text", async () => {
    invoke(render().button(SCENARIOS[4].title), "onClick");
    invoke(render().textarea(), "onChange", { target: { value: SCENARIOS[0].text } });
    await respond(0, benign);
    expect(render().textarea().props.value).toBe(SCENARIOS[0].text);
    expect(content(render().tree)).not.toContain("BENIGN_RESULT");
  });
});

describe("stage 3 cycle 2: transfer attempt ownership", () => {
  it.each([
    ["intervene", "Отменить перевод", "cancelled_by_client", "Перевод отменён", "Готово"],
    ["intervene", "Спросить доверенного человека", "held_for_trusted_contact", "Перевод на удержании", "Вернуться"],
    ["warn", "Всё верно, перевести", "proceeded", "Перевод выполнен", "Новый перевод"],
  ])("%s / %s records the frozen attempt exactly once", async (decision, action, outcome, heading, back) => {
    invoke(render().button(SCENARIOS[0].title), "onClick");
    await respond(0, scam);
    const submitting = invoke(render().form(), "onSubmit", { preventDefault() {} });
    expect(render().nodes.find((n) => n.props.id === "amount")?.props.disabled).toBe(true);
    expect(render().nodes.find((n) => n.type === "fieldset")?.props.disabled).toBe(true);
    // The scenario controls remain active while assessment is pending.
    invoke(render().button(SCENARIOS[4].title), "onClick");
    await respond(2, benign);
    await respond(1, { decision, riskScore: decision === "warn" ? 45 : 100, reasons: scam.reasons, message: scam });
    await submitting;
    invoke(render().button(action), "onClick");
    expect(content(render().tree)).toContain(heading);
    const writes = requests.filter((r) => r.url === "/api/cases");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({
      amount: 450000, newRecipient: true, messageText: SCENARIOS[0].text,
      channel: "call", outcome,
    });
    invoke(render().button(back), "onClick");
    expect(render().form()).toBeDefined();
    expect(requests.filter((r) => r.url === "/api/cases")).toHaveLength(1);
  });
});
