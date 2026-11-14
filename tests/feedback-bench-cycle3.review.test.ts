import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { approveCandidates, heldOutRepresentations, matchesHeldOut, toJsonl } from "@/lib/feedback";
import type { DatasetItem } from "@/lib/dataset";

const item: DatasetItem = { id: "ru-legit-001", lang: "ru", channel: "sms", label: "legit", scamType: null, split: "dev", text: "Синтетический пример о расписании занятий в учебной аудитории." };

describe("feedback cycle 3: boundaries and write failure", () => {
  const held = "Начало сообщения. Синтетическая независимая выборка содержит уникальное описание проверки банковского перевода. Конец сообщения.";
  const guard = new Set(heldOutRepresentations(held));

  it("rejects exactly 50 characters embedded in unrelated text after normalization", () => {
    const quote = held.slice(23, 73).toUpperCase().replaceAll(" ", " \t\n ");
    expect(matchesHeldOut(`Вставка: ${quote} — комментарий.`, guard)).toBe(true);
  });

  it("documents the accepted limitation for partial quotes under 50 characters", () => {
    expect(matchesHeldOut(held.slice(23, 72), guard)).toBe(false);
  });

  it("still rejects exact held-out texts shorter than 50 characters", () => {
    const short = "Короткий отложенный текст.";
    expect(matchesHeldOut(short.toUpperCase(), new Set(heldOutRepresentations(short)))).toBe(true);
  });

  it("rejects duplicates created by remasking edited candidates", () => {
    const a = { ...item, text: "Синтетический пример: код: 593842, никому не передавайте." };
    const b = { ...a, id: "ru-legit-002", text: a.text.replace("593842", "385921") };
    expect(() => approveCandidates(toJsonl([a, b]), new Set())).toThrow(/повтор текста/);
  });

  it("C5: failed disk write must preserve the previously approved file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qalqan-cycle3-"));
    try {
      const dataset = join(dir, "data/dataset");
      mkdirSync(dataset, { recursive: true });
      for (const name of ["challenge-2.jsonl", "challenge-4.jsonl"]) {
        writeFileSync(join(dataset, name), readFileSync(resolve("data/dataset", name)));
      }
      const previous = toJsonl([{ ...item, text: "Прежний одобренный синтетический пример для сохранения при ошибке." }]);
      const target = join(dataset, "feedback.jsonl");
      writeFileSync(target, previous);
      writeFileSync(join(dataset, "feedback.candidates.jsonl"), toJsonl([item]));
      const preload = join(dir, "disk-failure.cjs");
      // Simulate a disk-full failure after opening/truncating and writing a prefix.
      // Applies to any dataset output, including a future atomic temporary file.
      writeFileSync(preload, `
        const fs = require('node:fs');
        const path = require('node:path');
        const original = fs.writeFileSync;
        fs.writeFileSync = function(file, data, ...rest) {
          if (typeof file === 'string' && path.resolve(file).startsWith(path.resolve('data/dataset') + path.sep)) {
            original.call(this, file, String(data).slice(0, 12), ...rest);
            throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
          }
          return original.call(this, file, data, ...rest);
        };
        require('node:module').syncBuiltinESMExports();
      `);
      const run = spawnSync(process.execPath, ["--require", preload, "--import", import.meta.resolve("tsx"), resolve("scripts/export-feedback.ts"), "--approve"], { cwd: dir, encoding: "utf8", timeout: 15_000 });
      if (run.error) throw run.error;
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("injected ENOSPC");
      expect(readFileSync(target, "utf8")).toBe(previous);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
