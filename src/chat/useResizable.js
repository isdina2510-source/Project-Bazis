import { useCallback, useEffect, useRef, useState } from "react";

const resolve = (value) => (typeof value === "function" ? value() : value);

function readStored(key) {
  if (!key) return NaN;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? NaN : Number(raw);
  } catch {
    return NaN;
  }
}

function store(key, value) {
  if (!key) return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

/**
 * Размер блока, который меняется перетаскиванием разделителя, колесом и стрелками.
 *
 * direction: -1 — блок растёт, когда разделитель тянут вверх (разделитель над блоком), 1 — вниз.
 * min / max — числа или функции (например, от высоты окна).
 * collapsible — если при отпускании размер меньше collapseBelow, блок сворачивается в 0;
 *               разворачивается кликом по разделителю (toggle) к последнему открытому размеру.
 */
export function useResizable({
  storageKey,
  initial,
  min,
  max,
  direction = -1,
  step = 16,
  collapsible = false,
  collapseBelow = 56,
}) {
  const clamp = useCallback(
    (value) => {
      const lo = collapsible && value <= 0 ? 0 : resolve(min);
      return Math.round(Math.min(resolve(max), Math.max(lo, value)));
    },
    [min, max, collapsible]
  );

  const [size, setSizeState] = useState(() => {
    const saved = readStored(storageKey);
    return clamp(Number.isFinite(saved) && (saved > 0 || collapsible) ? saved : resolve(initial));
  });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const lastOpenRef = useRef(size > 0 ? size : resolve(initial));
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const setSize = useCallback(
    (value, { persist = true } = {}) => {
      const next = clamp(value);
      if (next > 0) lastOpenRef.current = next;
      setSizeState(next);
      if (persist) store(storageKey, next);
      return next;
    },
    [clamp, storageKey]
  );

  /** Во время перетаскивания можно уйти ниже min — так видно, что блок вот-вот свернётся. */
  const setDragSize = useCallback(
    (value) => {
      const lo = collapsible ? 0 : resolve(min);
      setSizeState(Math.round(Math.min(resolve(max), Math.max(lo, value))));
    },
    [collapsible, min, max]
  );

  const settle = useCallback(
    (value) => {
      if (collapsible && value < Math.min(collapseBelow, resolve(min))) return setSize(0);
      return setSize(Math.max(value, resolve(min)));
    },
    [collapsible, collapseBelow, min, setSize]
  );

  const resizeBy = useCallback((delta) => settle(sizeRef.current + delta), [settle]);

  const toggle = useCallback(() => {
    if (!collapsible) return;
    setSize(sizeRef.current > 0 ? 0 : lastOpenRef.current || resolve(initial));
  }, [collapsible, initial, setSize]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    document.body.classList.remove("chat-resizing");
    if (drag.moved) settle(sizeRef.current);
    else if (collapsible) toggle();
  }, [settle, toggle, collapsible]);

  useEffect(() => () => document.body.classList.remove("chat-resizing"), []);

  const handleProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "horizontal",
    "aria-valuenow": size,
    "aria-valuemin": collapsible ? 0 : resolve(min),
    "aria-valuemax": resolve(max),
    onPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startSize: sizeRef.current, moved: false };
      setDragging(true);
      document.body.classList.add("chat-resizing");
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // без захвата перетаскивание тоже работает, пока указатель над разделителем
      }
    },
    onPointerMove(event) {
      const drag = dragRef.current;
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dy) < 4) return;
      drag.moved = true;
      setDragSize(drag.startSize + direction * dy);
    },
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    onLostPointerCapture: finishDrag,
    onKeyDown(event) {
      const grow = direction < 0 ? "ArrowUp" : "ArrowDown";
      const shrink = direction < 0 ? "ArrowDown" : "ArrowUp";
      if (event.key === grow) resizeBy(step);
      else if (event.key === shrink) resizeBy(-step);
      else if (collapsible && (event.key === "Enter" || event.key === " ")) toggle();
      else return;
      event.preventDefault();
    },
  };

  return { size, setSize, resizeBy, toggle, collapsed: collapsible && size === 0, dragging, handleProps };
}
