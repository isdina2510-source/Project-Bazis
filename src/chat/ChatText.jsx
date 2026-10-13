/**
 * Мини-разметка ответов чата: «### заголовок», списки (•, -, 1.),
 * **акцент**, «цитаты» и ссылки. Рендер через React — без innerHTML.
 */

import { CONTACT_PHONE, getTelegramProfileUrl } from "../lib/catalog.js";

/** Ссылка: с https:// или адрес мессенджера без схемы (t.me/…, wa.me/…) — его тоже подменяем. */
const INLINE_RE =
  /(«[^»]+»)|(\*\*[^*]+\*\*)|(https?:\/\/[^\s<]+|\b(?:[\w-]+\.)?(?:t\.me|telegram\.me|telegram\.dog|wa\.me)\/[^\s<]*)/gi;
/** Знаки после ссылки в конце фразы — не часть адреса. */
const URL_TAIL_RE = /[.,;:!?»"'…]+$|\)+$/;

/**
 * Адрес для ссылки или null, если это не адрес. Мессенджеры в ответе ИИ — только наши контакты:
 * модель может выдумать чужой аккаунт.
 */
function contactUrl(url) {
  const full = /^https?:\/\//i.test(url) ? url : "https://" + url;
  let host;
  try {
    host = new URL(full).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "t.me" || host.endsWith(".t.me") || host === "telegram.me" || host === "telegram.dog") {
    return getTelegramProfileUrl();
  }
  if (host === "wa.me" || host === "whatsapp.com" || host.endsWith(".whatsapp.com")) return "https://wa.me/" + CONTACT_PHONE;
  return full;
}

function splitUrlTail(raw) {
  let url = raw;
  let tail = "";
  for (let match = url.match(URL_TAIL_RE); match; match = url.match(URL_TAIL_RE)) {
    if (match[0].startsWith(")") && url.includes("(")) break;
    tail = match[0] + tail;
    url = url.slice(0, -match[0].length);
  }
  return [url, tail];
}

function renderInline(text) {
  const out = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [token, quote, em, url] = match;
    if (quote) {
      out.push(
        <span className="chat-quote" key={key++}>
          «{renderInline(quote.slice(1, -1))}»
        </span>
      );
    } else if (em) {
      out.push(
        <span className="chat-em" key={key++}>
          {renderInline(em.slice(2, -2))}
        </span>
      );
    } else if (url) {
      const [address, tail] = splitUrlTail(url);
      const href = contactUrl(address);
      if (!href) {
        out.push(url);
      } else {
        out.push(
          <a href={href} target="_blank" rel="noopener noreferrer" key={key++}>
            {href}
          </a>
        );
        if (tail) out.push(tail);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function ChatText({ text }) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let list = null;

  const closeList = () => {
    if (list) {
      blocks.push(
        <ul className="chat-list" key={"l" + blocks.length}>
          {list}
        </ul>
      );
      list = null;
    }
  };

  lines.forEach((rawLine, i) => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      closeList();
      return;
    }

    const heading = trimmed.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      closeList();
      blocks.push(
        <p className="chat-cat" key={i}>
          {renderInline(heading[1])}
        </p>
      );
      return;
    }

    const bullet = trimmed.match(/^(?:•|·|▪|‣|[-–—])\s+(.+)$/);
    const numbered = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (bullet || numbered) {
      if (!list) list = [];
      list.push(<li key={i}>{renderInline(bullet ? bullet[1] : numbered[2])}</li>);
      return;
    }

    closeList();
    blocks.push(
      <p className="chat-p" key={i}>
        {renderInline(trimmed)}
      </p>
    );
  });
  closeList();

  return blocks.length ? blocks : <p className="chat-p" />;
}
