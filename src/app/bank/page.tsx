import type { Metadata } from "next";
import Link from "next/link";
import { BankDemo } from "@/components/bank/BankDemo";

export const metadata: Metadata = {
  title: "Qalqan — демо мобильного банка",
  description: "Перевод с учётом контекста: Qalqan останавливает перевод, если перед ним было мошенническое сообщение или звонок.",
};

export default function BankPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          ← Qalqan
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Демо: перевод под защитой Qalqan</h1>
        <p className="max-w-2xl text-zinc-600 dark:text-zinc-400">
          Банк видит обычный перевод. Qalqan видит ещё и то, что клиенту сказали перед ним, — и вмешивается до подтверждения.
          Это демонстрационный макет: деньги не переводятся, данные вымышлены.
        </p>
      </header>
      <BankDemo />
    </main>
  );
}
