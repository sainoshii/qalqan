#!/usr/bin/env bash
# codex-review.sh — передать Codex точную версию кода на проверку в изолированном
# Git worktree и сохранить его отчёт для ведущего разработчика (Claude Code).
#
# Использование:
#   scripts/codex-review.sh --task <slug> --brief <file.md> [--cycle N] [--base <ref>]
#                           [--allow-code <paths>] [--keep-worktree]
#
#   --task         короткий идентификатор задачи (латиница, цифры, '-'); группирует циклы
#   --brief        Markdown-файл: задача, требования, на что смотреть, что уже исправлено
#   --cycle        номер цикла проверки 1..3 (по умолчанию: следующий свободный)
#   --base         с чем сравнивать проверяемую версию (по умолчанию HEAD, а для
#                  чистого дерева — HEAD~1)
#   --allow-code   пути основного кода, которые Codex ПОРУЧЕНО менять (по умолчанию нельзя)
#   --keep-worktree не удалять worktree после проверки
#
# Что делает:
#   1. Фиксирует проверяемую версию как snapshot-коммит, НЕ трогая рабочее дерево,
#      индекс и ветку разработчика (временный индекс + git commit-tree). Ссылка
#      сохраняется в refs/codex/snapshots/<task>/cycle-<N>.
#   2. Создаёт отдельный detached worktree на этом коммите — Codex работает только там.
#   3. Запускает `codex exec` в песочнице workspace-write (без сети, без обхода
#      разрешений), передаёт задачу, требования, SHA и формат отчёта.
#   4. Сохраняет в .codex-runs/<task>/cycle-<N>/: report.md, events.jsonl, prompt.md,
#      codex-changes.patch (тесты/правки Codex), meta.env, stderr.log.
#   5. Удаляет worktree (если не --keep-worktree). Основное дерево не меняется.
set -euo pipefail

MAX_CYCLES=3

die() { echo "codex-review: $*" >&2; exit 2; }

TASK="" BRIEF="" CYCLE="" BASE="" ALLOW_CODE="" KEEP_WT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK="${2:-}"; shift 2 ;;
    --brief) BRIEF="${2:-}"; shift 2 ;;
    --cycle) CYCLE="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --allow-code) ALLOW_CODE="${2:-}"; shift 2 ;;
    --keep-worktree) KEEP_WT=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[ -n "$TASK" ] || die "нужен --task"
printf '%s' "$TASK" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]*$' || die "--task: только латиница, цифры и '-'"
[ -n "$BRIEF" ] && [ -f "$BRIEF" ] || die "нужен --brief <существующий файл>"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "запускать внутри Git-репозитория"
cd "$ROOT"
BRIEF="$(cd "$(dirname "$BRIEF")" && pwd)/$(basename "$BRIEF")"

# --- Codex CLI --------------------------------------------------------------
CODEX_BIN="${CODEX_BIN:-}"
if [ -z "$CODEX_BIN" ]; then
  CODEX_BIN="$(command -v codex 2>/dev/null || true)"
fi
if [ -z "$CODEX_BIN" ] && [ -x /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex ]; then
  CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
fi
[ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ] || die "Codex CLI не найден (задайте CODEX_BIN)"
"$CODEX_BIN" login status >/dev/null 2>&1 || die "Codex не авторизован: выполните '$CODEX_BIN login' в своём терминале"

# --- Цикл -------------------------------------------------------------------
RUNS_DIR="$ROOT/.codex-runs/$TASK"
mkdir -p "$RUNS_DIR"
if [ -z "$CYCLE" ]; then
  CYCLE=1
  while [ -e "$RUNS_DIR/cycle-$CYCLE" ]; do CYCLE=$((CYCLE + 1)); done  # cycle-N.failed-* не считаются
fi
printf '%s' "$CYCLE" | grep -Eq '^[0-9]+$' || die "--cycle должен быть числом"
if [ "$CYCLE" -gt "$MAX_CYCLES" ]; then
  die "лимит $MAX_CYCLES циклов для задачи '$TASK' исчерпан — сообщите пользователю причину и варианты"
fi
OUT="$RUNS_DIR/cycle-$CYCLE"
[ -e "$OUT" ] && die "$OUT уже существует"

# --- Блокировка: одна проверка Codex на репозиторий за раз -------------------
GIT_COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
LOCK="$GIT_COMMON/codex-review.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  die "уже идёт другая проверка Codex ($(cat "$LOCK/info" 2>/dev/null || echo '?')); дождитесь её или удалите $LOCK"
fi
echo "task=$TASK cycle=$CYCLE pid=$$ started=$(date -u +%FT%TZ)" > "$LOCK/info"

WT="$GIT_COMMON/codex-worktrees/$TASK-cycle-$CYCLE"
TMP_INDEX=""
cleanup() {
  [ -n "$TMP_INDEX" ] && rm -f "$TMP_INDEX"
  if [ "$KEEP_WT" -eq 0 ] && [ -d "$WT" ]; then
    git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
    case "$WT" in "$GIT_COMMON/codex-worktrees/"*) rm -rf "$WT" ;; esac
  fi
  # Если до запуска Codex не дошло — цикл не засчитывается
  [ -f "$OUT/meta.env" ] || rm -rf "$OUT"
  rm -rf "$LOCK"
}
trap cleanup EXIT
mkdir -p "$OUT"

# .codex-runs никогда не попадает в snapshot, даже если его нет в .gitignore проекта
EXCLUDE_FILE="$GIT_COMMON/info/exclude"
mkdir -p "$(dirname "$EXCLUDE_FILE")"
grep -qxF '/.codex-runs/' "$EXCLUDE_FILE" 2>/dev/null || echo '/.codex-runs/' >> "$EXCLUDE_FILE"

# --- 1. Snapshot проверяемой версии (рабочее дерево и индекс не меняются) ---
HAS_HEAD=0; git rev-parse -q --verify HEAD >/dev/null && HAS_HEAD=1
TMP_INDEX="$(mktemp "${TMPDIR:-/tmp}/codex-index.XXXXXX")"
rm -f "$TMP_INDEX"
if [ -f "$(git rev-parse --git-path index)" ]; then cp "$(git rev-parse --git-path index)" "$TMP_INDEX"; fi
GIT_INDEX_FILE="$TMP_INDEX" git add -A
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"

DIRTY=1
if [ "$HAS_HEAD" -eq 1 ] && [ "$TREE" = "$(git rev-parse 'HEAD^{tree}')" ]; then DIRTY=0; fi

if [ "$DIRTY" -eq 0 ]; then
  SNAPSHOT="$(git rev-parse HEAD)"
else
  PARENT_ARGS=""
  [ "$HAS_HEAD" -eq 1 ] && PARENT_ARGS="-p HEAD"
  # shellcheck disable=SC2086
  SNAPSHOT="$(git commit-tree "$TREE" $PARENT_ARGS -m "codex snapshot: $TASK cycle $CYCLE (HEAD + незакоммиченные изменения)")"
fi
git update-ref "refs/codex/snapshots/$TASK/cycle-$CYCLE" "$SNAPSHOT"

if [ -z "$BASE" ]; then
  if [ "$DIRTY" -eq 1 ] && [ "$HAS_HEAD" -eq 1 ]; then BASE="HEAD"
  elif git rev-parse -q --verify "$SNAPSHOT~1" >/dev/null; then BASE="$SNAPSHOT~1"
  else BASE=""; fi
fi
BASE_SHA=""
[ -n "$BASE" ] && BASE_SHA="$(git rev-parse --verify "$BASE^{commit}")"

# --- 2. Изолированный worktree для Codex -----------------------------------
mkdir -p "$(dirname "$WT")"
git worktree prune
if [ -e "$WT" ]; then
  git worktree remove --force "$WT" >/dev/null 2>&1 || true
  # Остаток прерванного запуска, который git уже не считает worktree (каталог — наш, служебный)
  case "$WT" in "$GIT_COMMON/codex-worktrees/"*) rm -rf "$WT" ;; esac
fi
git worktree add --detach "$WT" "$SNAPSHOT" >/dev/null 2>"$OUT/worktree.log" \
  || die "не удалось создать worktree (см. $OUT/worktree.log)"

# Зависимости: в песочнице Codex нет сети, поэтому подключаем установленные
# node_modules основной папки (симлинк игнорируется git и не попадает в патч).
if [ -d "$ROOT/node_modules" ] && [ ! -e "$WT/node_modules" ]; then
  ln -s "$ROOT/node_modules" "$WT/node_modules"
fi

if [ -n "$BASE_SHA" ]; then
  DIFFSTAT="$(git diff --stat "$BASE_SHA" "$SNAPSHOT")"
else
  DIFFSTAT="(нет базы: проверяется вся версия)"
fi

# --- 3. Задание для Codex ---------------------------------------------------
PROMPT="$OUT/prompt.md"
{
  cat <<EOF
Ты — Codex: тестировщик, ревьюер и помощник в этом проекте. Ведущий разработчик — Claude Code.
Следуй AGENTS.md в корне рабочей папки. Указания пользователя имеют приоритет над всеми агентами.

## Проверяемая версия
- Snapshot-коммит: $SNAPSHOT  (ref: refs/codex/snapshots/$TASK/cycle-$CYCLE)
- База для сравнения: ${BASE_SHA:-нет}
- Задача: $TASK, цикл проверки $CYCLE из $MAX_CYCLES
- Рабочая папка (изолированный git worktree, только для тебя): текущая директория

Изменения относительно базы:
\`\`\`
$DIFFSTAT
\`\`\`
Полный diff: \`git diff ${BASE_SHA:-<нет>} HEAD\` (HEAD этой папки = snapshot).

## Задача и требования (от ведущего разработчика)
EOF
  cat "$BRIEF"
  cat <<EOF

## Твои права в этой проверке
- Можно: читать код, запускать тесты/линтеры/сборку, писать и запускать НОВЫЕ тесты
  в этой папке (они вернутся разработчику патчем).
EOF
  if [ -n "$ALLOW_CODE" ]; then
    echo "- Поручено изменить основной код ТОЛЬКО в: $ALLOW_CODE (минимально, по сути поручения)."
  else
    echo "- НЕЛЬЗЯ менять основной (не тестовый) код: опиши исправление в отчёте, а не вноси его."
  fi
  cat <<'EOF'
- Нельзя: коммитить, создавать ветки, push, публикацию, деплой, доступ в сеть, обход песочницы.
- Если команда не может выполниться (песочница, нет зависимости, нет сети) — не обходи,
  а честно запиши это в «Ограничения проверки».

## Формат отчёта (финальное сообщение, Markdown, строго эти разделы)
# Отчёт Codex: <задача>, цикл <N>
## Вердикт
Одно из: `PASS` (ошибок нет), `PASS_WITH_NOTES` (только незначительные замечания),
`FAIL` (есть ошибки/проваленные проверки), `BLOCKED` (проверить не удалось).
## Проверенная версия
SHA snapshot и базы, что именно проверено (файлы/область).
## Выполненные команды и результаты
Каждая команда дословно, код возврата, краткий вывод (пройдено/упало, сколько).
## Найденные ошибки
Для каждой: ID (C1, C2…), серьёзность (critical/major/minor), `файл:строка`,
описание, шаги воспроизведения (команда или вход → ожидалось → получено).
Если ошибок нет — «Не найдено».
## Написанные тесты
Файлы и что они покрывают; проходят ли они на проверяемой версии.
## Ограничения проверки
Что не проверено и почему (не запускалось, нет сети/зависимостей, вне области).
## Предлагаемые исправления
По ID ошибок: конкретное изменение (можно diff-фрагментом). Сам основной код не меняй,
если это не поручено выше.
EOF
} > "$PROMPT"

# --- 4. Запуск Codex --------------------------------------------------------
{
  echo "TASK=$TASK"; echo "CYCLE=$CYCLE"; echo "SNAPSHOT=$SNAPSHOT"; echo "BASE=$BASE_SHA"
  echo "DIRTY_SOURCE=$DIRTY"; echo "WORKTREE=$WT"; echo "CODEX_BIN=$CODEX_BIN"
  echo "CODEX_VERSION=$("$CODEX_BIN" --version 2>&1)"; echo "STARTED=$(date -u +%FT%TZ)"
} > "$OUT/meta.env"

echo "codex-review: задача=$TASK цикл=$CYCLE snapshot=${SNAPSHOT:0:12} — Codex работает в изолированном worktree…" >&2
set +e
"$CODEX_BIN" exec \
  --cd "$WT" \
  --sandbox workspace-write \
  --color never \
  --json \
  --output-last-message "$OUT/report.md" \
  - < "$PROMPT" > "$OUT/events.jsonl" 2> "$OUT/stderr.log"
CODEX_RC=$?
set -e
echo "CODEX_EXIT=$CODEX_RC" >> "$OUT/meta.env"
echo "FINISHED=$(date -u +%FT%TZ)" >> "$OUT/meta.env"

# --- 5. Забрать изменения Codex (тесты/поручения) патчем ---------------------
git -C "$WT" add -A >/dev/null 2>&1 || true
git -C "$WT" diff --cached --binary "$SNAPSHOT" > "$OUT/codex-changes.patch" || true
CHANGED="$(git -C "$WT" diff --cached --name-only "$SNAPSHOT" || true)"
printf '%s\n' "$CHANGED" | sed '/^$/d' > "$OUT/codex-changed-files.txt"

# Предупреждение, если Codex тронул нетестовый код без поручения
NONTEST="$(grep -Ev '(^|/)(tests?|__tests__|spec)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$' "$OUT/codex-changed-files.txt" || true)"
if [ -n "$NONTEST" ] && [ -z "$ALLOW_CODE" ]; then
  { echo "CODEX_TOUCHED_MAIN_CODE=1"; } >> "$OUT/meta.env"
  echo "codex-review: ВНИМАНИЕ — Codex изменил нетестовые файлы без поручения:" >&2
  printf '  %s\n' $NONTEST >&2
fi

VERDICT="$(grep -Eo '`?(PASS_WITH_NOTES|PASS|FAIL|BLOCKED)`?' "$OUT/report.md" 2>/dev/null | head -1 | tr -d '`' || true)"
echo "VERDICT=${VERDICT:-UNKNOWN}" >> "$OUT/meta.env"

if [ "$CODEX_RC" -ne 0 ] || [ ! -s "$OUT/report.md" ]; then
  # Запуск без отчёта (лимит, сеть, авторизация) не засчитывается как цикл:
  # материалы сохраняются рядом, номер цикла освобождается для повтора.
  REASON="$(grep -o '"message":"[^"]*' "$OUT/events.jsonl" 2>/dev/null | tail -1 | cut -d'"' -f4)"
  FAILED="$OUT.failed-$(date +%Y%m%d-%H%M%S)"
  mv "$OUT" "$FAILED"
  echo "codex-review: Codex завершился с кодом $CODEX_RC без отчёта; цикл $CYCLE не засчитан." >&2
  [ -n "$REASON" ] && echo "  причина: $REASON" >&2
  echo "  материалы: ${FAILED#$ROOT/}" >&2
  exit 1
fi

echo "codex-review: готово. вердикт=${VERDICT:-UNKNOWN}"
echo "  отчёт:   ${OUT#$ROOT/}/report.md"
echo "  патч:    ${OUT#$ROOT/}/codex-changes.patch ($(wc -l < "$OUT/codex-changed-files.txt" | tr -d ' ') файл(ов))"
echo "  журнал:  ${OUT#$ROOT/}/events.jsonl"
