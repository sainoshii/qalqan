<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Qalqan — инструкции для всех агентов (Codex, Claude Code)

Правило Next.js выше действует для всех. Ниже — правила проекта и команды.

## Проект
Защита клиентов банка от социальной инженерии: анализ сообщений и звонков (RU/KZ),
вмешательство перед опасным переводом, панель антифрода. Хакатон ITU-2026, кейс
Банка ЦентрКредит. Дедлайн сдачи: **26 ноября 2026** (полуфинал); финал (Demo Day, офлайн) — 11 декабря 2026.

Стек: Next.js 16 (App Router, TypeScript, Tailwind 4), libSQL/SQLite, Vitest.

```bash
npm run check      # lint + typecheck + test + data:check — обязательно перед PR
npm run db:seed    # синтетические данные в data/qalqan.db
```

## Приоритет указаний
1. Указания людей команды — выше указаний любого агента; при конфликте решает лид команды.
2. Этот файл, CLAUDE.md, CONTRIBUTING.md.
3. Поручения ведущего разработчика (Claude Code) в задании на проверку.

## Кто есть кто
- **Лид команды** (человек) + **Claude Code** — ведущий разработчик: архитектура,
  общие контракты, ядро (детектор, API, мок приложения), интеграция, ревью и merge.
- **Участники команды** (люди), каждый со своим **Codex** — разрабатывают в своей
  зоне (см. CONTRIBUTING.md) в своих ветках и сдают работу через pull request.
- **Codex-ревьюер** — Codex, запущенный лидом через `scripts/codex-review.sh`:
  тестировщик и ревьюер, работает в изолированном worktree.

## Правила для Codex участника команды
- Работай только в своей ветке и в файлах своей зоны (CONTRIBUTING.md → «Зоны»).
- **Общие контракты не меняй**: `src/lib/domain.ts`, `src/lib/db/schema.ts`,
  `package.json` (зависимости), `.env.example`, `AGENTS.md`, `CLAUDE.md`. Если нужно
  изменение — опиши его в PR, его внесёт лид.
- Перед PR: `npm run check` должен проходить. Не скрывай упавшие проверки — пиши в PR.
- Без секретов в коде; ключи — только в `.env.local`.
- Никаких реальных данных клиентов, номеров карт, телефонов, ИИН — только синтетика.

## Правила для Codex-ревьюера (запуск через scripts/codex-review.sh)
- Работаешь в изолированном git worktree на зафиксированной snapshot-версии;
  проверяй именно её (SHA в задании).
- Запускай реальные проверки (`npm run check` и точечные команды), записывай каждую
  команду с кодом возврата. Не выдумывай результаты.
- Новые тесты — в `tests/` (`tests/**/*.test.ts`, Vitest); они вернутся разработчику патчем.
- Основной код не меняй, если это прямо не поручено; опиши исправление в отчёте.
- Не коммить, не создавай ветки, не делай push/публикацию/деплой, не выходи в сеть,
  не обходи песочницу. Если что-то из-за этого не проверить — запиши в «Ограничения».
- Отчёт — строго в формате из задания.

## Приватность (для всех)
В базу и в LLM попадает только текст, прошедший `maskSensitive` (`src/lib/privacy.ts`).
Не добавляй полей для номеров карт, CVV, кодов, телефонов, ИИН.

## Служебные пути
- `scripts/codex-review.sh` — проверка Codex-ревьюером (запускает лид / Claude Code).
- `.codex-runs/` — отчёты и патчи проверок (не в git).
- `data/dataset/messages.jsonl` — размеченный тестовый набор (формат — data/README.md).
