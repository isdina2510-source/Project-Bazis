/** Модуль сборки не загрузился — обычно вкладка открыта до пересборки сайта и ссылается на старые файлы. */
export const CHUNK_ERROR_RE = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch|Unable to preload/i;

const RELOAD_KEY = "bazis_chunk_reload";
/** Повторная автоперезагрузка не раньше чем через 5 минут: иначе битая сборка перезагружала бы страницу по кругу. */
const RELOAD_GUARD_MS = 5 * 60 * 1000;

export function isChunkError(error) {
  const text = error && typeof error === "object" ? error.message : error;
  return CHUNK_ERROR_RE.test(String(text || ""));
}

/** Одна автоматическая перезагрузка за 5 минут (отметка в sessionStorage); false — уже перезагружали или некуда записать. */
export function reloadOnceForChunkError(reload = () => window.location.reload(), now = Date.now()) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    if (last && now - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
