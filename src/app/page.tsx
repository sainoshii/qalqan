import Link from "next/link";

const MODULES: Array<{ title: string; text: string; stage: string; href?: string }> = [
  {
    title: "Анализ сообщения",
    text: "Текст SMS, мессенджера или расшифровки звонка на русском или казахском — риск-скор, тип схемы и объяснение.",
    stage: "Готово",
    href: "/bank",
  },
  {
    title: "Мобильный банк (демо)",
    text: "Перевод с учётом контекста: новый получатель, сумма, недавнее подозрительное сообщение. Экран вмешательства при высоком риске.",
    stage: "Готово",
    href: "/bank",
  },
  {
    title: "Панель антифрода",
    text: "Помеченные случаи, статистика по типам схем и карточка случая для сотрудника банка.",
    stage: "Этап 4 · в разработке",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-4 py-16 sm:px-6">
      <header className="flex flex-col gap-4">
        <p className="text-sm font-medium uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
          Qalqan · қалқан — «щит»
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Защита клиентов банка от мошенничества с социальной инженерией
        </h1>
        <p className="max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
          Когда клиента убеждают перевести деньги самому, обычный антифрод видит штатную операцию. Qalqan анализирует
          сообщения и звонки, объясняет риск и останавливает опасный перевод до подтверждения.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3" aria-label="Модули">
        {MODULES.map((m) => (
          <article
            key={m.title}
            className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
          >
            <span className="text-xs font-medium text-zinc-500">{m.stage}</span>
            <h2 className="font-semibold">{m.title}</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.text}</p>
            {m.href && (
              <Link href={m.href} className="mt-auto pt-2 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400">
                Открыть демо →
              </Link>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
