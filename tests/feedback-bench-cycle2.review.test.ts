import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { buildFeedbackDataset, toJsonl, type FeedbackRow } from "@/lib/feedback";
import { excerpt, maskSensitive } from "@/lib/privacy";
import { heldOutGuard, loadTraining } from "../scripts/train-model";

const held = parseDataset(readFileSync("data/dataset/challenge-2.jsonl", "utf8")).items.find(i => i.id === "kk-legit-231")!;
const partial = held.text.slice(held.text.indexOf("Кіруді"));
const row = (text: string): FeedbackRow => ({
  id: "cycle2-review", created_at: "2026-11-15T00:00:00Z", channel: "sms",
  language: "kk", text_excerpt: text, scam_type: null, status: "false_positive",
});

function approval(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "qalqan-approve-review-"));
  try {
    mkdirSync(join(dir, "data/dataset"), { recursive: true });
    for (const name of ["challenge-2.jsonl", "challenge-4.jsonl"]) {
      writeFileSync(join(dir, "data/dataset", name), readFileSync(resolve("data/dataset", name)));
    }
    writeFileSync(join(dir, "data/dataset/feedback.candidates.jsonl"), content);
    const target = join(dir, "data/dataset/feedback.jsonl");
    writeFileSync(target, "previous approved data\n");
    const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("scripts/export-feedback.ts"), "--approve"], {
      cwd: dir, encoding: "utf8", timeout: 15_000,
    });
    if (run.error) throw run.error;
    return { status: run.status, stderr: run.stderr, output: readFileSync(target, "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("feedback cycle 2: holdout fragments and approval boundary", () => {
  it("rejects uppercase cropped and masked holdout", () => {
    const result = buildFeedbackDataset([row(excerpt(held.text, 100).toUpperCase())], heldOutGuard().texts);
    expect(result.items).toEqual([]);
  });

  it("C1: rejects a substantial partial quote during export", () => {
    expect(partial.length).toBeGreaterThan(40);
    expect(buildFeedbackDataset([row(partial)], heldOutGuard().texts).items).toEqual([]);
  });

  it("C1: training independently rejects the same partial quote", () => {
    const dir = mkdtempSync(join(tmpdir(), "qalqan-training-review-"));
    try {
      const file = join(dir, "feedback.jsonl");
      writeFileSync(file, toJsonl([{ ...held, split: "dev", text: partial }]));
      expect(() => loadTraining([file])).toThrow(/Отложенн/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("approval rejects malformed candidates without replacing approved data", () => {
    const result = approval("{broken json\n");
    expect(result.status).toBe(1);
    expect(result.output).toBe("previous approved data\n");
  });

  it("approval rejects full masked holdout without replacing approved data", () => {
    const result = approval(toJsonl([{ ...held, split: "dev", text: maskSensitive(held.text) }]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("отложенных");
    expect(result.output).toBe("previous approved data\n");
  });

  it("C1: approval rejects a partial quote without replacing approved data", () => {
    const result = approval(toJsonl([{ ...held, split: "dev", text: partial }]));
    expect(result.status).toBe(1);
    expect(result.output).toBe("previous approved data\n");
  });

  it("C4: approval cannot write unmasked secrets inserted while editing candidates", () => {
    const text = "Синтетический пример: карта 4400 4300 1234 5678; телефон +7 701 555 12 34; ИИН 990101300123; код: 593842.";
    const result = approval(toJsonl([{ ...held, split: "dev", text }]));
    // Either refuse the edited file, or repeat masking before writing it.
    if (result.status === 1) expect(result.output).toBe("previous approved data\n");
    else {
      expect(result.status).toBe(0);
      expect(parseDataset(result.output).items[0].text).toBe(maskSensitive(text));
    }
  });
});
