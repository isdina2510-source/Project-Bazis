/**
 * Разговор с ИИ-консультантом, общий для двух независимых виджетов: ИИ-чат его пишет,
 * виджет связи (WhatsApp/Telegram) читает — чтобы заявка в CRM ушла вместе с перепиской,
 * а в сообщение WhatsApp попали вопрос посетителя и номер обращения.
 */
import { useSyncExternalStore } from "react";
import { createChatLeadSession } from "./handoff-lead.js";

const EMPTY = { history: [], lastUserText: "", lastFileNames: [], direction: "", handoff: false };

let state = EMPTY;
let lead = null;
const listeners = new Set();

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => state;

export function updateChatSession(patch) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

/** Одна заявка в CRM на разговор (см. handoff-lead.js). */
export function getChatLead() {
  if (!lead) lead = createChatLeadSession();
  return lead;
}

export function resetChatSession() {
  lead = null;
  updateChatSession(EMPTY);
}

export function useChatSession() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
