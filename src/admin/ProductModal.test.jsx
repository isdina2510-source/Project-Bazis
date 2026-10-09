import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch-mock.js";
import { DialogHost, closeDialogs } from "./dialogs.jsx";
import ProductModal from "./ProductModal.jsx";
import { createProduct } from "../lib/products-api.js";

afterEach(() => closeDialogs());

/** Image, которая «открывается» (decodes: true) или нет — как HEIC в Chrome. */
function stubImage({ decodes }) {
  URL.createObjectURL = vi.fn(() => "blob:photo");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 4000;
      naturalHeight = 3000;
      set src(_value) {
        setTimeout(() => (decodes ? this.onload() : this.onerror()));
      }
    }
  );
}

function renderModal(product = null) {
  const onSaved = vi.fn();
  const view = render(
    <>
      <ProductModal product={product} onClose={() => {}} onSaved={onSaved} />
      <DialogHost />
    </>
  );
  return { ...view, onSaved };
}

function choosePhoto(container, file) {
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
}

function fillRequired() {
  fireEvent.change(screen.getByPlaceholderText("Название"), { target: { value: "Сайт-визитка" } });
  fireEvent.change(screen.getByPlaceholderText("Описание"), { target: { value: "Описание услуги" } });
  fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "50000" } });
}

describe("LOW-14: «формат не поддерживается» и «слишком большое» — разные сообщения", () => {
  test("HEIC, который браузер не открывает, — про формат, а не про размер", async () => {
    stubImage({ decodes: false });
    const { container } = renderModal();
    choosePhoto(container, new File([new Uint8Array(2 * 1024 * 1024)], "IMG_0001.HEIC", { type: "image/heic" }));
    const notice = await screen.findByText(/формат фото браузер не открывает/);
    expect(notice.textContent).toMatch(/HEIC/);
    expect(screen.queryByText(/слишком большое/)).toBeNull();
  });

  test("HEIC без MIME-типа (так бывает в Windows) тоже получает сообщение о формате, а не молчание", async () => {
    stubImage({ decodes: false });
    const { container } = renderModal();
    choosePhoto(container, new File([new Uint8Array(1000)], "photo.heic", { type: "" }));
    await screen.findByText(/формат фото браузер не открывает/);
  });

  test("картинка открылась, но и после сжатия больше предела — «слишком большое»", async () => {
    stubImage({ decodes: true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64," + "A".repeat(3 * 1024 * 1024));
    const { container } = renderModal();
    choosePhoto(container, new File([new Uint8Array(5 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" }));
    await screen.findByText(/Фото слишком большое/);
    expect(screen.queryByText(/формат фото/)).toBeNull();
  });
});

describe("MED-14: товар без фото", () => {
  test("сохраняется с пустой картинкой, а не со стоковой фотографией unsplash", async () => {
    const fetchMock = mockFetch({
      "POST /api/products": (_url, init) => jsonResponse({ id: "p1", ...JSON.parse(init.body) }, 201),
    });
    const { onSaved } = renderModal();
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.image).toBe("");
    expect(JSON.stringify(body)).not.toMatch(/unsplash/);
    expect(onSaved.mock.calls[0][0].image).toBe("");
  });

  test("«Убрать фото» у товара с картинкой отправляет пустое значение", async () => {
    const fetchMock = mockFetch({
      "PATCH /api/products/p1": (_url, init) => jsonResponse({ id: "p1", ...JSON.parse(init.body) }),
    });
    const product = { id: "p1", title: "Сайт", description: "Описание", price: 1000, currency: "KZT", kind: "service", category: "infrastructure", image: "images/uploads/img_a.jpg", stock: null };
    const { onSaved } = renderModal(product);
    fireEvent.click(screen.getByRole("button", { name: "Убрать фото" }));
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).image).toBe("");
  });
});

describe("LOW-02: ошибки валидации сервера показываются понятным текстом", () => {
  test("клиент не подменяет неизвестную валюту и раздел молча — их проверяет сервер", async () => {
    const fetchMock = mockFetch({ "POST /api/products": jsonResponse({ error: "invalid_currency", message: "Неизвестная валюта" }, 400) });
    await expect(
      createProduct({ title: "Т", description: "О", price: 1, currency: "EUR", kind: "service", category: "removed" })
    ).rejects.toThrow("Неизвестная валюта");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.currency).toBe("EUR");
    expect(body.category).toBe("removed");
  });

  test.each([
    ["invalid_currency", "Неизвестная валюта: выберите тенге, рубли или доллары."],
    ["invalid_category", "Такого раздела нет: выберите раздел из списка."],
  ])("%s — текст сервера в форме, а не код", async (code, message) => {
    mockFetch({ "POST /api/products": jsonResponse({ error: code, message }, 400) });
    renderModal();
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const alert = await screen.findByText(message);
    expect(alert.getAttribute("role")).toBe("alert");
  });
});
