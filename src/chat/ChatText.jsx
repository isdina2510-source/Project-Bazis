/**
 * Мини-разметка ответов чата: «### заголовок», списки (•, -, 1.),
 * **акцент**, «цитаты» и ссылки. Рендер через React — без innerHTML.
 */

const INLINE_RE = /(«[^»]+»)|(\*\*[^*]+\*\*)|(https?:\/\/[^\s<]+)/g;

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
      out.push(
        <a href={url} target="_blank" rel="noopener noreferrer" key={key++}>
          {url}
        </a>
      );
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
