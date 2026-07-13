import { DEFAULT_LOCALE, type Locale } from './catalog.ts';
import { normalizeLocale } from './index.ts';

export const LANGUAGE_PREFERENCE_KEY = 'safety-lens-language';

export function restoreLanguage(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage): Locale {
  try { return normalizeLocale(storage?.getItem(LANGUAGE_PREFERENCE_KEY)); } catch { return DEFAULT_LOCALE; }
}

export function persistLanguage(locale: Locale, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage): void {
  try { storage?.setItem(LANGUAGE_PREFERENCE_KEY, locale); } catch { /* Non-critical preference. */ }
}

export function updateDocumentLanguage(locale: Locale, documentValue: Document | null = globalThis.document): void {
  documentValue?.documentElement.setAttribute('lang', locale);
}
