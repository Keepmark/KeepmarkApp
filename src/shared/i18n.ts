// UI localization. DOM-free and SW-safe: static imports only. Logs stay English.
import { en, type MessageKey } from './i18n/en.js';
import { it } from './i18n/it.js';
import { fr } from './i18n/fr.js';
import { es } from './i18n/es.js';
import { de } from './i18n/de.js';
import { ja } from './i18n/ja.js';
import { pt } from './i18n/pt.js';
import { ru } from './i18n/ru.js';
import { zh } from './i18n/zh.js';

export type { MessageKey };
export type Lang = 'en' | 'it' | 'fr' | 'es' | 'de' | 'ja' | 'pt' | 'ru' | 'zh';
export type LangSetting = 'system' | Lang;
export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'it', 'fr', 'es', 'de', 'ja', 'pt', 'ru', 'zh'];

const CATALOGS: Record<Lang, Record<MessageKey, string>> = { en, it, fr, es, de, ja, pt, ru, zh };

let current: Lang = 'en';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (SUPPORTED_LANGS as readonly string[]).includes(v);
}

/** Explicit language wins; otherwise the base language of the system tag; else en. */
export function resolveLang(setting: unknown, systemTag: string | undefined): Lang {
  if (isLang(setting)) return setting;
  const base = (systemTag ?? '').toLowerCase().split(/[-_]/)[0];
  return isLang(base) ? base : 'en';
}

export function setLang(lang: Lang): void {
  current = lang;
}
export function getLang(): Lang {
  return current;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = CATALOGS[current][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Plural: picks `${base}_one` / `${base}_other`; `count` is always a param. */
export function tn(base: string, count: number, params?: Record<string, string | number>): string {
  const form = new Intl.PluralRules(current).select(count) === 'one' ? 'one' : 'other';
  return t(`${base}_${form}` as MessageKey, { count, ...params });
}

export function formatDateTime(d: Date | string | number): string {
  return new Date(d).toLocaleString(current);
}
export function formatDate(d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleDateString(current, opts);
}
export function formatTime(d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleTimeString(current, opts);
}

const CONTAINER_KEYS: Record<string, MessageKey> = {
  Menu: 'container.menu',
  Other: 'container.other',
  Toolbar: 'container.toolbar',
};

/**
 * Display-only: swap the sync-format root titles ("[xbs] Other", ...) inside a
 * path or sample line for the localized browser names. Synced data keeps the
 * "[xbs] ..." titles; call this only when rendering text.
 */
export function displayPath(text: string): string {
  return text.replace(/\[xbs\] (Menu|Other|Toolbar)(?=$| \/ | → |,)/g, (_, k: string) => t(CONTAINER_KEYS[k]));
}
