import { catalogs, DEFAULT_LOCALE, type Locale, type Message } from './catalog.ts';

export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : DEFAULT_LOCALE;
}

function interpolate(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => key in values ? String(values[key]) : match);
}

export function createTranslator(localeValue: unknown = DEFAULT_LOCALE) {
  const locale = normalizeLocale(localeValue);
  return (key: string, values: Record<string, string | number> = {}): string => {
    const selected = catalogs[locale][key];
    const fallback = catalogs[DEFAULT_LOCALE][key];
    const resource: Message | undefined = selected ?? fallback;
    if (!resource) return key;
    const message = typeof resource === 'string'
      ? resource
      : Number(values.count) === 1 ? resource.one : resource.other;
    return interpolate(message, values);
  };
}
