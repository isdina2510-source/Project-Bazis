/**
 * Копирование текста в буфер обмена. Вызывать синхронно в обработчике клика: после await браузер
 * считает действие не пользовательским и запрещает копирование.
 * Сначала execCommand (работает и без HTTPS, и в старых браузерах), затем Clipboard API.
 * @returns {Promise<boolean>} удалось ли скопировать
 */
export function copyText(text) {
  const value = String(text || "");
  if (!value) return Promise.resolve(false);
  if (copyWithSelection(value)) return Promise.resolve(true);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(value).then(
        () => true,
        () => false
      );
    }
  } catch {
    // Clipboard API недоступен
  }
  return Promise.resolve(false);
}

/** Временное поле вне экрана + document.execCommand("copy"); фокус возвращается на прежний элемент. */
function copyWithSelection(value) {
  if (typeof document === "undefined" || !document.body) return false;
  const active = document.activeElement;
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("aria-hidden", "true");
  // Не readonly: iOS Safari не выделяет текст в readonly-поле. Шрифт 16px — без автозума на iOS.
  field.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;font-size:16px;";
  document.body.appendChild(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    field.remove();
    try {
      if (active && typeof active.focus === "function") active.focus({ preventScroll: true });
    } catch {
      // ignore
    }
  }
  return copied;
}
