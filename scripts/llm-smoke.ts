/**
 * Проверка подключения LLM после добавления ключа:
 *
 *   ANTHROPIC_API_KEY=... npm run llm:smoke
 *
 * Три коротких синтетических сообщения → три платных запроса (доли цента на Haiku).
 * Показывает вердикт LLM и задержку каждого; код выхода 1, если LLM не ответила или
 * ответ явно неверный (мошенничество с низким риском, обычное — с высоким).
 * Ключ и тексты не печатаются в лог — только результат.
 */
import { DEFAULT_MODEL, askLlm, llmConfigured } from "../src/lib/detector/llm";
import { maskSensitive } from "../src/lib/privacy";
import type { Language } from "../src/lib/domain";

export const SMOKE_CASES: Array<{ name: string; lang: Language; text: string; expect: "scam" | "legit" }> = [
  {
    name: "мошенничество, без ключевых слов правил",
    lang: "ru",
    text: "Мама, я разбил телефон, пишу с номера друга. Скинь, пожалуйста, 40 тысяч ему на карту, вечером всё объясню.",
    expect: "scam",
  },
  {
    name: "настоящее уведомление банка",
    lang: "ru",
    text: "Код для входа: 4821. Никому не сообщайте этот код, сотрудники банка никогда его не спрашивают.",
    expect: "legit",
  },
  {
    name: "мошенничество на казахском",
    lang: "kk",
    text: "Сәлеметсіз бе, банктің қауіпсіздік қызметі. Шотыңызға күдікті кіру байқалды, SMS-тегі кодты айтыңызшы.",
    expect: "scam",
  },
];

async function main() {
  if (!llmConfigured()) {
    console.error("ANTHROPIC_API_KEY не задан — LLM не подключена. Задайте ключ в .env.local или в окружении.");
    process.exit(1);
  }
  console.log(`Модель: ${process.env.QALQAN_LLM_MODEL || DEFAULT_MODEL}`);
  let failed = 0;
  for (const c of SMOKE_CASES) {
    const started = performance.now();
    try {
      const verdict = await askLlm(maskSensitive(c.text), c.lang);
      const ms = Math.round(performance.now() - started);
      if (!verdict) {
        failed += 1;
        console.log(`✗ ${c.name}: нет вердикта (отказ модели или неверный формат), ${ms} мс`);
        continue;
      }
      const ok = c.expect === "scam" ? verdict.riskScore >= 40 : verdict.riskScore < 70;
      if (!ok) failed += 1;
      console.log(
        `${ok ? "✓" : "✗"} ${c.name}: риск ${verdict.riskScore}, тип ${verdict.scamType ?? "—"}, ${ms} мс` +
          (verdict.reasons.length ? `\n    причины: ${verdict.reasons.join("; ")}` : ""),
      );
    } catch (err) {
      failed += 1;
      const ms = Math.round(performance.now() - started);
      // Только класс и статус ошибки — без тела запроса
      const status = (err as { status?: number }).status;
      console.log(`✗ ${c.name}: ошибка ${err instanceof Error ? err.name : "unknown"}${status ? ` (HTTP ${status})` : ""}, ${ms} мс`);
    }
  }
  if (failed) {
    console.error(`\nНе прошло: ${failed} из ${SMOKE_CASES.length}.`);
    process.exit(1);
  }
  console.log("\nLLM подключена и отвечает. Дальше: npm run eval -- --llm --file data/dataset/challenge-2.jsonl");
}

if (process.argv[1]?.endsWith("llm-smoke.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.name : err);
    process.exit(1);
  });
}
