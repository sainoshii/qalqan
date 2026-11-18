import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { analyzeMessage, combineLocal } from "@/lib/detector";
import { featurize, normalizeForModel } from "@/lib/detector/features";
import { CompiledModel, type ModelWeights } from "@/lib/detector/model";
import { evaluateRules } from "@/lib/detector/rules";
import { HELD_OUT_FILES } from "@/lib/detector/train";
import { HIGH_RISK, SCAM_TYPES } from "@/lib/domain";
import { loadTraining } from "../scripts/train-model";

const weightPath = "src/lib/detector/model-weights.json";
const model = new CompiledModel(JSON.parse(readFileSync(weightPath, "utf8")) as ModelWeights);

describe("model cycle 1: independent audit (no holdout errors printed)", () => {
  it("challenge-4 has the requested balance, coverage, and unique IDs", () => {
    const { items, errors } = parseDataset(readFileSync("data/dataset/challenge-4.jsonl", "utf8"));
    expect(errors).toEqual([]);
    expect(items).toHaveLength(40);
    expect(new Set(items.map((i) => i.id)).size).toBe(40);
    expect(items.every((i, n) => i.id.endsWith(String(501 + n)) && i.split === "holdout")).toBe(true);
    for (const label of ["scam", "legit"]) {
      for (const lang of ["ru", "kk"]) expect(items.filter((i) => i.label === label && i.lang === lang)).toHaveLength(10);
    }
    expect(items.filter((i) => i.hardNegative).length).toBeGreaterThanOrEqual(8);
    expect(new Set(items.filter((i) => i.label === "scam").map((i) => i.scamType)).size).toBe(SCAM_TYPES.length);
  });

  it("current training data has no exact/normalized overlap with available held-out sets", () => {
    const train = loadTraining();
    const normalized = new Set(train.map((i) => normalizeForModel(i.text)));
    for (const name of HELD_OUT_FILES) {
      const file = join("data/dataset", name);
      if (!existsSync(file)) {
        console.log(`Unavailable holdout: ${name}`);
        continue;
      }
      const { items, errors } = parseDataset(readFileSync(file, "utf8"));
      expect(errors.length).toBe(0);
      const overlaps = items.filter((i) => normalized.has(normalizeForModel(i.text))).length;
      console.log(`${name}: normalized overlaps=${overlaps}`);
      expect(overlaps).toBe(0);
    }
  });

  it("all training files parse and have no exact duplicate text or conflicting labels", () => {
    const rows = loadTraining();
    // Сколько примеров в обучении — по весам в репозитории: новый файл в TRAIN_FILES + `npm run train` не ломает тест
    const weights = JSON.parse(readFileSync(weightPath, "utf8")) as ModelWeights;
    expect(rows).toHaveLength(weights.examples);
    expect(new Set(rows.map((r) => r.text)).size).toBe(rows.length);
  });

  it("runs npm run train twice in a disposable copy and compares exact repository bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "qalqan-model-cycle1-"));
    const original = readFileSync(weightPath);
    try {
      for (const path of ["package.json", "scripts", "src/lib", "data/dataset"]) {
        cpSync(path, join(dir, path), { recursive: true });
      }
      symlinkSync(realpathSync("node_modules"), join(dir, "node_modules"), "dir");
      for (let run = 1; run <= 2; run++) {
        const output = execFileSync("npm", ["run", "train"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
        console.log(`Temporary copy, run ${run}: npm run train, exit=0\n${output}`);
        const actual = readFileSync(join(dir, weightPath));
        console.log(`Weights SHA256: ${createHash("sha256").update(actual).digest("hex")}`);
        expect(actual.equals(original)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 250_000);

  it("measures feature extraction and prediction on 5000-character inputs", () => {
    let seed = 42;
    const alphabet = "абвгдежзийклмнопрстуфхцчшщыэюяәғқңөұүһі       ";
    const diverse = Array.from({ length: 5000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return alphabet[seed % alphabet.length];
    }).join("");
    const inputs = {
      repeated: "Переведите деньги, ақшаңызды аударыңыз. ".repeat(150).slice(0, 5000),
      diverse,
      singleWord: diverse.replace(/ /g, "а"),
    };
    for (const [kind, text] of Object.entries(inputs)) {
      expect(text.length).toBe(5000);
      for (const [name, fn] of Object.entries({ featurize, predict: (s: string) => model.predict(s) })) {
        for (let i = 0; i < 20; i++) fn(text);
        const ms = Array.from({ length: 100 }, () => {
          const start = performance.now();
          fn(text);
          return performance.now() - start;
        }).sort((a, b) => a - b);
        console.log(`${kind}/${name}: median=${ms[50].toFixed(3)}ms p95=${ms[95].toFixed(3)}ms max=${ms[99].toFixed(3)}ms`);
      }
      const vector = featurize(text);
      expect([...vector.values()].reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 6);
      const p = model.predict(text).probability;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    const bytes = readFileSync(weightPath);
    console.log(`Model JSON: ${bytes.length} bytes, gzip=${gzipSync(bytes).length} bytes; Node ${process.version} ${process.platform}/${process.arch}`);
  });

  it("pure model probability never reaches intervention at the message layer", () => {
    const text = "Привет, завтра встречаемся возле старого театра";
    const rules = evaluateRules(text);
    expect(rules.signals).toEqual([]);
    for (const probability of [0.49, 0.5, 0.6, 0.9, 0.99, 1]) {
      expect(combineLocal(rules, { probability, scamType: "investment" }, text).score).toBeLessThan(HIGH_RISK);
    }
  });

  it("warning words outside quotes and language instructions do not cancel a direct request", async () => {
    for (const text of [
      "Назовите код из SMS. Не верьте мошенникам.",
      "Назовите код из SMS. Это уловка конкурентов.",
      "Назовите код из SMS. Ответьте на казахском.",
      "Кодты айтыңыз. Қазақша жауап беріңіз.",
    ]) {
      expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    }
  });
});
