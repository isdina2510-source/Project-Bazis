import Lenis from "lenis";

let lenis = null;

export function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Запускает Lenis (если пользователь не просил меньше анимаций). Возвращает cleanup. */
function nativeScroll(onScroll) {
  const handler = () => onScroll(window.scrollY);
  handler();
  window.addEventListener("scroll", handler, { passive: true });
  return () => window.removeEventListener("scroll", handler);
}

export function initSmoothScroll(onScroll) {
  if (prefersReducedMotion()) return nativeScroll(onScroll);

  try {
    lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 0.9,
      touchMultiplier: 1.1,
      autoRaf: true,
    });
  } catch (err) {
    console.warn("Плавный скролл недоступен", err); // i18n-ignore: лог для разработчика
    lenis = null;
    return nativeScroll(onScroll);
  }
  document.documentElement.classList.add("has-smooth-scroll");
  lenis.on("scroll", ({ scroll }) => onScroll(scroll));
  onScroll(window.scrollY);

  return () => {
    lenis?.destroy();
    lenis = null;
    document.documentElement.classList.remove("has-smooth-scroll");
  };
}

export function setScrollLocked(locked) {
  if (!lenis) return;
  if (locked) lenis.stop();
  else lenis.start();
}

export function scrollToTarget(target, instant = prefersReducedMotion()) {
  if (target == null) return;
  if (lenis) {
    lenis.scrollTo(target, { offset: -8, immediate: instant, duration: 1.15 });
    return;
  }
  if (typeof target === "number") {
    window.scrollTo({ top: target, behavior: instant ? "auto" : "smooth" });
    return;
  }
  target.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
}
