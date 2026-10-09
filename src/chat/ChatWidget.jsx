import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CONTACT_PHONE, getTelegramProfileUrl } from "../lib/catalog.js";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { buildHandoffMessage, whatsappUrl } from "../lib/messages.js";
import { useStore } from "../store/StoreContext.jsx";
import { MAX_ATTACHMENTS, formatBytes, prepareAttachment } from "./attachments.js";
import ChatQuick from "./ChatQuick.jsx";
import ChatText from "./ChatText.jsx";
import { consultCloud } from "./cloud.js";
import { createChatLeadSession, hasClientMessages, sendChatLead } from "./handoff-lead.js";
import { warmOrderProof } from "../lib/order-proof.js";
import { useResizable } from "./useResizable.js";
import {
  consultOffline,
  findProductByQuery,
  isBackQuery,
  normalize,
} from "./consult.js";

const HEIGHT_KEY = "bazis_chat_height";
const SECTIONS_KEY = "bazis_chat_sections_height";
const COMPOSE_KEY = "bazis_chat_input_height";
const MIN_H = 360;
const MAX_HISTORY = 40;
const CONTEXT_CHARS_PER_FILE = 1500;

/** Краткое содержимое вложений для истории — чтобы ИИ помнил файл в следующих репликах. */
// i18n-ignore-start: служебный контекст для ИИ, пользователю не показывается
function buildFilesContext(files) {
  return files
    .map((f) => {
      if (f.kind === "text" && f.text) {
        const clipped = f.text.length > CONTEXT_CHARS_PER_FILE;
        return "[Ранее приложен файл «" + f.name + "»]\n" + f.text.slice(0, CONTEXT_CHARS_PER_FILE) + (clipped ? "…" : "");
      }
      if (f.kind === "text") return "[Ранее приложен файл «" + f.name + "» — " + (f.summary || "без текста") + "]";
      if (f.kind === "image") return "[Ранее приложено изображение «" + f.name + "»]";
      if (f.kind === "error") return "[Файл «" + f.name + "» не прочитан]";
      return "[Ранее приложен файл «" + f.name + "»]";
    })
    .join("\n\n");
}
// i18n-ignore-end

const maxHeight = () => Math.max(MIN_H, Math.floor(window.innerHeight * 0.92));
const initialHeight = () => Math.min(620, maxHeight());
const WHEEL_FACTOR = 0.45;
/** Шапка, ползунок высоты, поле ввода, кнопки мессенджеров и минимум переписки — разделам остаётся остальное. */
const PANEL_CHROME_PX = 430;
const SECTIONS_MIN = 90;
const SECTIONS_INITIAL = 240;
const COMPOSE_MIN = 44;
const COMPOSE_MAX = 220;
const SCROLLERS = ".chat-messages, .chat-quick, .chat-compose textarea";

let messageSeq = 0;

function BubbleFiles({ files }) {
  return (
    <div className="chat-bubble-files">
      {files.map((f, i) =>
        f.kind === "image" && f.previewUrl ? (
          <a key={i} className="chat-bubble-img" href={f.previewUrl} target="_blank" rel="noopener noreferrer">
            <img src={f.previewUrl} alt={f.name} />
          </a>
        ) : (
          <div key={i} className="chat-bubble-file">
            <strong>{f.name}</strong>
            <span>{formatBytes(f.size || 0)}</span>
          </div>
        )
      )}
    </div>
  );
}

export default function ChatWidget() {
  const { products, chatOpen: open, setChatOpen } = useStore();
  const { lang, t } = useI18n();

  const [history, setHistory] = useState([]);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState([]);
  const [quickSection, setQuickSection] = useState("");
  const [afterConsult, setAfterConsult] = useState(false);
  const [lastUserText, setLastUserText] = useState("");
  const [lastFileNames, setLastFileNames] = useState([]);
  const [handoff, setHandoff] = useState(false);
  const [handoffChannel, setHandoffChannel] = useState("whatsapp");
  const [readingFiles, setReadingFiles] = useState(0);

  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const busyRef = useRef(false);
  const historyRef = useRef(history);
  historyRef.current = history;
  /** Заявка в CRM при переходе в мессенджер — одна на разговор. */
  const leadRef = useRef(null);
  if (!leadRef.current) leadRef.current = createChatLeadSession();

  const panel = useResizable({ storageKey: HEIGHT_KEY, initial: initialHeight, min: MIN_H, max: maxHeight });
  const panelSizeRef = useRef(panel.size);
  panelSizeRef.current = panel.size;
  const sectionsMax = useCallback(() => Math.max(SECTIONS_MIN, panelSizeRef.current - PANEL_CHROME_PX), []);
  const sections = useResizable({
    storageKey: SECTIONS_KEY,
    initial: SECTIONS_INITIAL,
    min: SECTIONS_MIN,
    max: sectionsMax,
    collapsible: true,
  });
  const compose = useResizable({ storageKey: COMPOSE_KEY, initial: COMPOSE_MIN, min: COMPOSE_MIN, max: COMPOSE_MAX });
  const resizersRef = useRef({});
  resizersRef.current = { panel, sections, compose };

  const push = useCallback((role, text, attachments = [], context = "", sig = "") => {
    const id = ++messageSeq;
    setHistory((prev) => [...prev, { id, role, text: text || "", attachments, context, sig }].slice(-MAX_HISTORY));
    return id;
  }, []);

  const appendContext = useCallback((id, extra) => {
    setHistory((prev) =>
      prev.map((m) => (m.id === id ? { ...m, context: [m.context, extra].filter(Boolean).join("\n\n") } : m))
    );
  }, []);

  const showSections = () => {
    setQuickSection("");
    setAfterConsult(false);
  };

  // Приветствие при первом открытии + фокус в поле ввода.
  const greetedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (!greetedRef.current) {
      greetedRef.current = true;
      push("bot", t("chat.greeting"));
    }
    inputRef.current?.focus();
  }, [open, push, t]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, typing, open]);

  useEffect(() => {
    const onResize = () => resizersRef.current.panel.resizeBy(0);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Окно стало ниже — разделы не должны вытеснить переписку.
  useEffect(() => {
    const current = resizersRef.current.sections;
    if (current.size > sectionsMax()) current.resizeBy(0);
  }, [panel.size, sectionsMax]);

  // Поле ввода растёт под текст до COMPOSE_MAX, но не ниже высоты, выставленной пользователем.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = Math.min(COMPOSE_MAX, Math.max(compose.size, el.scrollHeight + borders)) + "px";
  }, [input, compose.size, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setChatOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setChatOpen]);

  /**
   * Колесо: над разделителем — меняет размер его блока; над шапкой/ползунком — высоту окна;
   * над прокручиваемой областью — прокручивает только её. Страница под чатом не скроллится.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !open) return undefined;
    const onWheel = (event) => {
      event.stopPropagation();
      const target = event.target instanceof Element ? event.target : null;
      const resizers = resizersRef.current;
      const handle = target && target.closest("[data-resize]");
      const resizer = handle ? resizers[handle.getAttribute("data-resize")] : null;
      if (resizer || (target && target.closest(".chat-height-bar, .chat-panel-head"))) {
        event.preventDefault();
        (resizer || resizers.panel).resizeBy(-event.deltaY * WHEEL_FACTOR);
        return;
      }
      const scroller = target && target.closest(SCROLLERS);
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
        const atTop = scroller.scrollTop <= 0 && event.deltaY < 0;
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 && event.deltaY > 0;
        if (atTop || atBottom) event.preventDefault();
        return;
      }
      event.preventDefault();
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [open]);

  const ask = async (text) => {
    const value = String(text || "").trim();
    const files = pendingFiles.slice();
    if ((!value && !files.length) || busyRef.current || readingFiles > 0) return;

    if (isBackQuery(value) && !files.length) {
      setLastUserText(value);
      push("user", value);
      setInput("");
      showSections();
      push("bot", t("chat.back_reply"));
      return;
    }

    busyRef.current = true;
    setLastUserText(value);
    setLastFileNames(files.filter((f) => f.kind !== "error").map((f) => f.name));
    const priorHistory = historyRef.current.slice();
    const userMessageId = push(
      "user",
      value,
      files.map((f) => ({ name: f.name, size: f.size, kind: f.kind, previewUrl: f.previewUrl || "" })),
      buildFilesContext(files)
    );
    setPendingFiles([]);
    setInput("");
    setHandoff(false);
    setTyping(true);

    try {
      let cloud = null;
      let cloudError = null;
      try {
        cloud = await consultCloud(value, files, priorHistory);
      } catch (err) {
        cloudError = err;
      }
      const result = cloud || consultOffline(products, value, files);
      setTyping(false);
      if (cloudError && !cloud) {
        const reason = String(cloudError.message || "").trim().replace(/[\s.!]+$/, "");
        const lead =
          cloudError.code === "body_too_large"
            ? reason
            : reason
              ? t("chat.error.cloud_unavailable_reason", { reason })
              : t("chat.error.cloud_unavailable");
        push("bot", t("chat.offline_lead", { lead }));
      }
      if (result.imageNotes) appendContext(userMessageId, "[Что было на изображениях]\n" + result.imageNotes); // i18n-ignore: контекст для ИИ
      push("bot", result.text, [], "", result.sig || "");
      setHandoff(!!result.handoff);
      if (result.offTopic) {
        showSections();
        return;
      }
      const matched = findProductByQuery(products, normalize(value));
      if (matched) {
        setQuickSection((prev) => matched.category || prev);
        setAfterConsult(true);
      }
    } catch {
      setTyping(false);
      push("bot", t("chat.parse_failed"));
      setHandoff(true);
    } finally {
      busyRef.current = false;
    }
  };

  const onFilesChosen = async (event) => {
    const list = Array.from(event.target.files || []);
    event.target.value = "";
    if (!list.length) return;
    setReadingFiles((n) => n + list.length);
    const prepared = [];
    for (const file of list) {
      try {
        const item = await prepareAttachment(file);
        if (item) prepared.push(item);
      } catch {
        prepared.push({ name: file.name, size: file.size, kind: "error", error: t("file.error.read_failed") });
      } finally {
        setReadingFiles((n) => n - 1);
      }
    }
    setPendingFiles((prev) => [...prev, ...prepared].slice(-MAX_ATTACHMENTS));
  };

  const hasDialog = hasClientMessages(history);
  useEffect(() => {
    if (open && hasDialog && !leadRef.current.sent) warmOrderProof().catch(() => {});
  }, [open, hasDialog]);
  const leadCode = hasDialog ? leadRef.current.code : "";
  const waHref = whatsappUrl(buildHandoffMessage(lastUserText, lastFileNames, lang, leadCode), CONTACT_PHONE);
  /** Не мешает переходу по ссылке: заявка уходит в фоне (keepalive). */
  const recordHandoff = (channel) => () => {
    setHandoffChannel(channel);
    sendChatLead(leadRef.current, { history: historyRef.current, channel, direction: quickSection });
  };

  return (
    <div
      ref={rootRef}
      className={"chat-widget" + (open ? " is-open" : "")}
      data-lenis-prevent=""
      data-lenis-prevent-wheel=""
      data-lenis-prevent-touch=""
    >
      <button
        type="button"
        className="chat-fab"
        aria-label={t("chat.open")}
        aria-expanded={open}
        onClick={() => setChatOpen(!open)}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21 12a8.5 8.5 0 0 1-12.7 7.4L3 21l1.7-5.1A8.5 8.5 0 1 1 21 12Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <span className="chat-fab-close" aria-hidden="true">
          ×
        </span>
      </button>

      <div
        ref={panelRef}
        className="chat-panel chat-panel-ai"
        hidden={!open}
        style={{ height: panel.size + "px", maxHeight: panel.size + "px" }}
      >
        <div
          className="chat-resize"
          data-resize="panel"
          title={t("chat.resize_title")}
          aria-label={t("chat.resize_label")}
          {...panel.handleProps}
        />
        <div className="chat-panel-head">
          <div>
            <strong>{t("chat.title")}</strong>
            <p>{t("chat.subtitle")}</p>
          </div>
          <button type="button" className="chat-panel-x" onClick={() => setChatOpen(false)} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="chat-height-bar">
          <label className="chat-height-label" htmlFor="chat-height-range">
            {t("chat.height")}
          </label>
          <input
            type="range"
            id="chat-height-range"
            className="chat-height-range"
            min={MIN_H}
            max={open ? maxHeight() : 900}
            step="10"
            value={panel.size}
            onChange={(event) => panel.setSize(Number(event.target.value) || MIN_H)}
            aria-label={t("chat.height_label")}
          />
          <span className="chat-height-value">{panel.size}px</span>
        </div>

        <div className="chat-messages" ref={messagesRef}>
          {history.map((m) => (
            <div key={m.id} className={"chat-bubble chat-bubble-" + (m.role === "bot" ? "bot" : "user")}>
              {m.attachments.length > 0 && <BubbleFiles files={m.attachments} />}
              {m.text && (
                <div className="chat-bubble-text">
                  <ChatText text={m.text} />
                </div>
              )}
            </div>
          ))}
          {typing && <div className="chat-bubble chat-bubble-bot chat-typing">{t("chat.typing")}</div>}
        </div>

        <div
          className={
            "chat-split chat-split-sections" +
            (sections.collapsed ? " is-collapsed" : "") +
            (sections.dragging ? " is-dragging" : "")
          }
          data-resize="sections"
          title={sections.collapsed ? t("chat.sections_show") : t("chat.sections_drag")}
          aria-label={t("chat.sections_size")}
          aria-expanded={!sections.collapsed}
          {...sections.handleProps}
        >
          <span className="chat-split-grip" aria-hidden="true" />
          {sections.collapsed && <span className="chat-split-label">{t("chat.sections_collapsed")}</span>}
        </div>

        {!sections.collapsed && (
          <ChatQuick
            style={{ height: sections.size + "px" }}
            products={products}
            sectionId={quickSection}
            afterConsult={afterConsult}
            onSection={(id) => {
              setQuickSection(id);
              setAfterConsult(false);
            }}
            onBack={showSections}
            onAsk={ask}
          />
        )}

        <div
          className={"chat-split chat-split-compose" + (compose.dragging ? " is-dragging" : "")}
          data-resize="compose"
          title={t("chat.compose_drag")}
          aria-label={t("chat.compose_size")}
          {...compose.handleProps}
        >
          <span className="chat-split-grip" aria-hidden="true" />
        </div>

        <div className="chat-attach-preview" hidden={!pendingFiles.length && !readingFiles}>
          {pendingFiles.map((f, i) => (
            <div className="chat-attach-chip" key={i} title={f.kind === "error" ? f.error : f.summary || f.name}>
              {f.kind === "image" && f.previewUrl ? (
                <img src={f.previewUrl} alt="" />
              ) : (
                <span className="chat-attach-icon">{f.kind === "error" ? "⚠️" : "📄"}</span>
              )}
              <span className="chat-attach-name">{f.name}</span>
              <button
                type="button"
                className="chat-attach-remove"
                aria-label={t("chat.remove_file")}
                onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
              >
                ×
              </button>
            </div>
          ))}
          {readingFiles > 0 && (
            <div className="chat-attach-chip">
              <span className="chat-attach-icon">⏳</span>
              <span className="chat-attach-name">{t("chat.reading_file")}</span>
            </div>
          )}
        </div>

        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            ask(input);
          }}
        >
          <button
            type="button"
            className="chat-attach-btn"
            aria-label={t("chat.attach_label")}
            title={t("chat.attach_title")}
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.pdf,.doc,.docx,.rtf,.odt,.xlsx,.ods,.pptx,.txt,.md,.csv,.json,application/pdf,text/*"
            hidden
            onChange={onFilesChosen}
          />
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={t("chat.placeholder")}
            autoComplete="off"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask(input);
              }
            }}
          />
          <button type="submit" className="chat-send" aria-label={t("chat.send")} disabled={readingFiles > 0}>
            ➤
          </button>
        </form>

        <div className="chat-actions">
          <a
            className={
              "chat-link chat-link-wa" + (handoffChannel === "whatsapp" ? " is-active" : "") + (handoff ? " is-pulse" : "")
            }
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={recordHandoff("whatsapp")}
          >
            {t("chat.continue_whatsapp")}
          </a>
          <a
            className={
              "chat-link chat-link-tg" + (handoffChannel === "telegram" ? " is-active" : "") + (handoff ? " is-pulse" : "")
            }
            href={getTelegramProfileUrl()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={recordHandoff("telegram")}
          >
            Telegram
          </a>
        </div>
      </div>
    </div>
  );
}
