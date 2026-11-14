import type { Metadata } from "next";
import Link from "next/link";
import { ANALYZE_EXAMPLE, ASSESS_EXAMPLE, computeExamples } from "@/lib/api/examples";
import { MAX_TEXT_LENGTH } from "@/lib/api/analyze-request";
import { MAX_BODY_BYTES } from "@/lib/api/http";
import { SCAM_TYPES } from "@/lib/domain";

export const metadata: Metadata = {
  title: "Qalqan — API для банка",
  description: "Как встроить Qalqan в мобильный банк: два вызова API, поля, ошибки, лимиты и приватность.",
};

const BASE = "https://qalqan-one.vercel.app";

/**
 * Примеры ответов считает настоящий детектор (без LLM). Вычисляются при пререндеринге и
 * кешируются (профиль cacheLife по умолчанию); новая сборка — новый ключ кеша.
 */
async function examples() {
  "use cache";
  return computeExamples();
}

const DECISION_LABEL = { allow: "allow — перевод проходит", warn: "warn — предупреждение", intervene: "intervene — экран «Стоп»" } as const;

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-900"
    >
      <code>{children}</code>
    </pre>
  );
}

function Fields({ rows }: { rows: Array<[string, string, string]> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Поле</th>
            <th className="py-2 pr-4 font-medium">Тип</th>
            <th className="py-2 font-medium">Описание</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {rows.map(([name, type, text]) => (
            <tr key={name}>
              <td className="py-2 pr-4 align-top font-mono text-xs">{name}</td>
              <td className="py-2 pr-4 align-top font-mono text-xs text-zinc-500">{type}</td>
              <td className="py-2 align-top text-zinc-700 dark:text-zinc-300">{text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const curl = (path: string, body: unknown) =>
  `curl -X POST ${BASE}${path} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(body)}'`;

export default async function DocsPage() {
  const ex = await examples();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-12 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <Link href="/" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          ← Qalqan
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">API для банка</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Qalqan встраивается в мобильный банк двумя вызовами. Проверка не хранит состояния и не получает реквизиты
          получателя; сервис можно развернуть в контуре банка. Без LLM сама проверка занимает около 0,2 мс на сообщение и
          около 2 мс на текст в 5000 символов (локальный замер, без сети); с подключённой LLM ответ ждёт её — до
          таймаута (по умолчанию 6 с, `QALQAN_LLM_TIMEOUT_MS`). Все примеры ниже посчитаны настоящим детектором.
        </p>
      </header>

      <Section id="flow" title="Интеграция за два вызова">
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
          <li>
            <strong>Пришло сообщение или идёт звонок</strong> — приложение отправляет текст (SMS, push, расшифровку звонка) в{" "}
            <code className="font-mono text-xs">POST /api/analyze</code> и при высоком риске сразу предупреждает клиента.
          </li>
          <li>
            <strong>Клиент подтверждает перевод</strong> — перед списанием приложение вызывает{" "}
            <code className="font-mono text-xs">POST /api/transfer/assess</code> с суммой, признаком нового получателя,
            недавним сообщением и сигналом звонка. Ответ — <code className="font-mono text-xs">allow</code>,{" "}
            <code className="font-mono text-xs">warn</code> или <code className="font-mono text-xs">intervene</code>.
          </li>
          <li>
            <strong>По желанию</strong> — исход (отменил, перевёл, ждёт доверенное лицо) отправляется в{" "}
            <code className="font-mono text-xs">POST /api/cases</code> и появляется в панели антифрода.
          </li>
        </ol>
      </Section>

      <Section id="analyze" title="POST /api/analyze — анализ сообщения">
        <Fields
          rows={[
            ["text", "string", `Текст сообщения или расшифровка звонка, RU или KZ, от 1 до ${MAX_TEXT_LENGTH} символов.`],
            ["lang", "\"ru\" | \"kk\"?", "Язык, если известен; иначе определяется автоматически."],
          ]}
        />
        <Code label="Пример запроса">{curl("/api/analyze", ANALYZE_EXAMPLE)}</Code>
        <Code label="Ответ">{json(ex.analyze)}</Code>
        <Fields
          rows={[
            ["riskScore", "0–100", "Риск: от 70 — высокий (мошенничество), от 40 — подозрительно."],
            ["scamType", "string | null", `Тип схемы: ${SCAM_TYPES.join(", ")}.`],
            ["reasons", "string[]", "Объяснения простыми словами — можно показывать клиенту как есть."],
            ["recommendation", "string", "Что сделать клиенту."],
            ["highlights", "{start, end, reason}[]", "Опасные фрагменты: позиции в UTF-16 (text.slice(start, end)) в тексте после обрезки пробелов по краям. Есть при риске от 40."],
            ["evidence", "rules | llm | model | none", "На чём держится риск. Одна статистическая модель (model) без подтверждения не вызывает вмешательство."],
            ["mode", "rules | hybrid", "hybrid — в ответе учтён результат LLM; rules — локальный результат (правила и модель), в том числе когда LLM не подключена или не ответила."],
          ]}
        />
      </Section>

      <Section id="assess" title="POST /api/transfer/assess — решение по переводу">
        <Fields
          rows={[
            ["amount", "integer", "Сумма в тенге, от 1 до 100 000 000."],
            ["newRecipient", "boolean", "true — клиент раньше не переводил этому получателю; false — переводил. Реквизиты получателя не передаются."],
            ["messageText", "string?", `Недавнее сообщение или расшифровка звонка, до ${MAX_TEXT_LENGTH} символов после обрезки пробелов — анализируется на сервере.`],
            ["onCall", "boolean?", "Сигнал устройства: во время перевода идёт телефонный разговор. Приложение банка получает его от ОС (Android — с разрешения клиента, iOS — CXCallObserver из CallKit). По умолчанию false."],
          ]}
        />
        <Code label="Пример запроса">{curl("/api/transfer/assess", ASSESS_EXAMPLE)}</Code>
        <Code label="Ответ">{json(ex.transfer)}</Code>
        <Fields
          rows={[
            ["decision", "allow | warn | intervene", "Что сделать с переводом: провести, предупредить или показать экран «Стоп»."],
            ["riskScore", "0–100", "Риск перевода с учётом контекста."],
            ["reasons", "string[]", "Причины для клиента (до 5); пусто при allow."],
            ["message", "object | null", "Ответ /api/analyze для messageText (те же поля) или null, если текста не было."],
          ]}
        />
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Правило двух сигналов: вмешательство требует подтверждённого риска текста (правила или LLM) либо подозрения модели
          вместе с идущим звонком. Звонок без подозрительного текста даёт только предупреждение и только для нового
          получателя. Риск считает сервер — клиент не может прислать «нужный» скор.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="pb-2 text-left text-xs text-zinc-500">Как меняется решение (посчитано детектором)</caption>
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Ситуация</th>
                <th className="py-2 pr-4 font-medium">Риск</th>
                <th className="py-2 font-medium">Решение</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {ex.scenarios.map((s) => (
                <tr key={s.title}>
                  <td className="py-2 pr-4">{s.title}</td>
                  <td className="py-2 pr-4 tabular-nums">{s.riskScore}</td>
                  <td className="py-2">{DECISION_LABEL[s.decision]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="other" title="Остальные маршруты">
        <Fields
          rows={[
            ["POST /api/cases", "{ amount, newRecipient, messageText?, onCall?, channel?, outcome }", "Записать исход попытки перевода для панели антифрода. Сохраняются только случаи с риском от 40 и только замаскированный фрагмент текста; риск пересчитывается на сервере."],
            ["GET /api/health", "—", "Состояние базы для диагностики (без адресов и токенов)."],
          ]}
        />
      </Section>

      <Section id="errors" title="Ошибки и лимиты">
        <Fields
          rows={[
            ["200", "Cache-Control: no-store", "Успешные ответы /api/analyze и /api/transfer/assess не кешируются."],
            ["400", "{ error }", "Некорректный JSON или поля (текст ошибки — на русском)."],
            ["413", "{ error }", `Тело запроса больше ${MAX_BODY_BYTES / 1024} КБ.`],
            ["415", "{ error }", "Нужен Content-Type: application/json."],
            ["429", "{ error }, Retry-After: 60", "Лимит частоты: /api/analyze и /api/transfer/assess — 30 запросов в минуту с адреса, /api/cases — 20 с адреса и 120 всего. Счётчики хранятся в памяти каждого экземпляра процесса: при нескольких экземплярах квоты у каждого свои, для общего лимита нужен общий счётчик (например, Redis). Значения заданы в коде маршрутов."],
            ["503", "{ stored: false, reason } / { status: \"error\", … }", "/api/cases — база недоступна (перевод клиента это не ломает); /api/health — база не отвечает."],
          ]}
        />
      </Section>

      <Section id="privacy" title="Приватность">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
          <li>Номера карт, CVV, коды, телефоны, ИИН и IBAN маскируются до записи в базу и до отправки в LLM.</li>
          <li>Тексты запросов не логируются; в базу пишется только короткий замаскированный фрагмент.</li>
          <li>Реквизиты получателя не передаются — только признак «новый получатель».</li>
          <li>
            Без LLM анализ выполняется на сервере Qalqan. Если сервер и база (для панели) размещены в контуре банка, тексты его
            не покидают; удалённая база (например, Turso) или подключённая LLM получают только замаскированный текст.
          </li>
        </ul>
      </Section>

      <Section id="deploy" title="Развёртывание в банке">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Node.js 20.9+: <code className="font-mono text-xs">npm ci &amp;&amp; npm run build &amp;&amp; npm start</code>. База —
          любая libSQL/SQLite (нужна только для панели). LLM подключается ключом и необязательна. Скорость и методика замера —{" "}
          <a href="https://github.com/sainoshii/qalqan/blob/main/docs/performance.md" className="text-emerald-700 hover:underline dark:text-emerald-400">
            docs/performance.md
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
