import { scrollToTarget } from "../lib/smooth-scroll.js";

/** Ссылка на якорь страницы (#about) с плавной прокруткой. */
export default function AnchorLink({ href, children, ...rest }) {
  const onClick = (event) => {
    if (!href || href === "#") return;
    const target = document.querySelector(href);
    if (!target) return;
    event.preventDefault();
    scrollToTarget(target);
  };

  return (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
