/** Общие помощники для JSON-обработчиков: лимит тела, тип содержимого, ошибки. */
export const MAX_BODY_BYTES = 32 * 1024;

export const jsonError = (status: number, message: string, headers?: HeadersInit) =>
  Response.json({ error: message }, { status, headers });

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/** Читает тело потоком и прекращает чтение, как только превышен лимит. */
async function readLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Разбирает JSON-тело с проверками; возвращает либо данные, либо готовый ответ с ошибкой. */
export async function readJson(request: Request): Promise<{ data: unknown } | { response: Response }> {
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { response: jsonError(415, "Ожидается Content-Type: application/json") };

  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return { response: jsonError(413, "Запрос слишком большой") };
  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return { response: jsonError(413, "Запрос слишком большой") };

  try {
    return { data: JSON.parse(raw) };
  } catch {
    return { response: jsonError(400, "Некорректный JSON") };
  }
}
