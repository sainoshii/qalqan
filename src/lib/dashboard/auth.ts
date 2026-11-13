/**
 * Доступ к панели антифрода.
 *
 * Если задан `QALQAN_DASHBOARD_PASSWORD`, панель и изменение статусов требуют HTTP Basic
 * (логин любой, пароль — из переменной). Без переменной панель открыта — это режим
 * демо для жюри; в README это указано как ограничение.
 */
export const DASHBOARD_REALM = 'Basic realm="Qalqan dashboard", charset="UTF-8"';

export function dashboardPassword(): string | undefined {
  return process.env.QALQAN_DASHBOARD_PASSWORD || undefined;
}

/** Сравнение без раннего выхода: время не зависит от того, где строки различаются. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function isDashboardAuthorized(authorization: string | null, password = dashboardPassword()): boolean {
  if (!password) return true;
  // Название схемы регистронезависимо (RFC 9110): «Basic», «basic», «BASIC»
  const match = authorization?.match(/^basic\s+(\S+)\s*$/i);
  if (!match) return false;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return false;
  }
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  const credentials = new TextDecoder().decode(bytes);
  const separator = credentials.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(credentials.slice(separator + 1), password);
}
