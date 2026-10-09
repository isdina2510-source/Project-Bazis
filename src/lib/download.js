/** Сохранить файл из памяти браузера через временную ссылку. */
export function downloadBlob(blob, filename) {
  if (!blob || !blob.size) throw new Error("Пустой файл: " + filename); // i18n-ignore: админка
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Ранний revoke обрывает скачивание в части браузеров — освобождаем ссылку с запасом.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
