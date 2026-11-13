import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center gap-4 px-4 py-16 sm:px-6">
      <p className="text-sm font-medium text-zinc-500">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Страница не найдена</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Возможно, ссылка устарела или случай был удалён вместе с демо-данными.
      </p>
      <div className="flex flex-wrap gap-4 text-sm font-medium">
        <Link href="/" className="text-emerald-700 hover:underline dark:text-emerald-400">
          На главную
        </Link>
        <Link href="/dashboard" className="text-emerald-700 hover:underline dark:text-emerald-400">
          К панели антифрода
        </Link>
      </div>
    </main>
  );
}
