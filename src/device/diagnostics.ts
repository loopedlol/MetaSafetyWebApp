import { DEVICE_RUNTIME, type DeviceCapabilities, type DeviceRuntime } from './device-adapter.ts';

export const DIAGNOSTICS_DB_NAME = 'safety-lens-device-diagnostics-v1';
const DIAGNOSTIC_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']);

export type AuthProbeStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'network_error' | 'unexpected_response';
export type ProbeStatus = 'checking' | 'supported' | 'unsupported' | 'passed' | 'failed';

export function isDeviceDiagnosticsEnabled(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('mode') === 'glasses' && params.get('adapter') === 'meta-display' && params.get('diagnostics') === '1';
}

export function exitDiagnosticsUrl(currentUrl: string): string {
  const url = new URL(currentUrl);
  url.searchParams.delete('diagnostics');
  return url.toString();
}

export function sanitizeUserAgent(userAgent: unknown): string {
  const input = String(userAgent ?? '');
  const withoutSensitiveValues = input
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted]')
    .replace(/\b(token|cookie|session|authorization|password|key)\s*[=:]\s*[^;\s)]+/gi, '$1=[redacted]');
  const platform = withoutSensitiveValues.match(/\(([^)]{1,80})\)/)?.[1] ?? 'platform unavailable';
  const products = [...withoutSensitiveValues.matchAll(/\b(?:Meta|Chrome|Chromium|CriOS|Safari|Version|Mobile|WebView|wv)[\/ ]([\w.-]{1,24})/gi)]
    .slice(0, 5)
    .map((match) => `${match[0].split(/[\/ ]/)[0]}/${match[1]}`);
  return `${platform}; ${products.join(' ') || 'browser version unavailable'}`
    .replace(/[^\p{L}\p{N} ._;/()\[\]-]/gu, '')
    .slice(0, 160);
}

export function sanitizeRuntimeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'Unknown runtime error');
  return raw
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/(?:file:\/\/)?(?:\/[\w .-]+){2,}/g, '[redacted-path]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b(?:password|registration[_ -]?key|cookie|authorization|session|token)\b\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 180);
}

export function summarizeFocus(element: Element | null): string {
  if (!element) return 'none';
  const tag = element.tagName.toLowerCase();
  const safeId = element.id?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const action = element.getAttribute('data-diagnostics-action')?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${tag}${safeId ? `#${safeId}` : ''}${action ? `[${action}]` : ''}`;
}

export function recordDiagnosticKey(event: Pick<KeyboardEvent, 'key' | 'type'>) {
  if (!DIAGNOSTIC_KEYS.has(event.key)) return null;
  return { key: event.key, eventType: event.type === 'keyup' ? 'keyup' : 'keydown' } as const;
}

export async function probeAuthentication(fetchImpl: typeof fetch = fetch): Promise<AuthProbeStatus> {
  try {
    const response = await fetchImpl('/api/auth/me', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (response.status === 200) return 'authenticated';
    if (response.status === 401) return 'unauthenticated';
    return 'unexpected_response';
  } catch {
    return 'network_error';
  }
}

export async function probeServiceWorker(serviceWorker: ServiceWorkerContainer | undefined) {
  if (!serviceWorker) return { support: 'unsupported' as ProbeStatus, registered: false, controlling: false };
  try {
    const registration = await serviceWorker.getRegistration();
    return { support: 'supported' as ProbeStatus, registered: Boolean(registration), controlling: Boolean(serviceWorker.controller) };
  } catch {
    return { support: 'supported' as ProbeStatus, registered: false, controlling: Boolean(serviceWorker.controller) };
  }
}

export async function probeIndexedDb(indexedDb: IDBFactory | undefined) {
  if (!indexedDb) return { status: 'unsupported' as ProbeStatus, cleanup: 'not_needed' as const };
  let database: IDBDatabase | null = null;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(DIAGNOSTICS_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('probe');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction('probe', 'readwrite');
      const store = transaction.objectStore('probe');
      store.put('disposable', 'current');
      store.delete('current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    database = null;
    await deleteDiagnosticsDatabase(indexedDb);
    return { status: 'passed' as ProbeStatus, cleanup: 'complete' as const };
  } catch {
    database?.close();
    try {
      await deleteDiagnosticsDatabase(indexedDb);
      return { status: 'failed' as ProbeStatus, cleanup: 'complete' as const };
    } catch {
      return { status: 'failed' as ProbeStatus, cleanup: 'failed' as const };
    }
  }
}

function deleteDiagnosticsDatabase(indexedDb: IDBFactory) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDb.deleteDatabase(DIAGNOSTICS_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Diagnostics database cleanup was blocked.'));
  });
}

export function createDiagnosticsSnapshot({ runtime, capabilities, windowLike = window, documentLike = document, navigatorLike = navigator }:
  { runtime: DeviceRuntime; capabilities: Readonly<DeviceCapabilities>; windowLike?: Window; documentLike?: Document; navigatorLike?: Navigator }) {
  return {
    runtime,
    adapter: runtime === DEVICE_RUNTIME.META_DISPLAY_WEB ? 'meta-display' : 'invalid',
    capabilities,
    viewport: { width: windowLike.innerWidth, height: windowLike.innerHeight, devicePixelRatio: windowLike.devicePixelRatio },
    userAgent: sanitizeUserAgent(navigatorLike.userAgent),
    latestKey: null as ReturnType<typeof recordDiagnosticKey>,
    focus: summarizeFocus(documentLike.activeElement),
    visibility: documentLike.visibilityState,
    network: navigatorLike.onLine ? 'online' : 'offline',
    serviceWorker: { support: 'checking' as ProbeStatus, registered: false, controlling: false },
    indexedDb: { status: 'checking' as ProbeStatus, cleanup: 'pending' as 'pending' | 'complete' | 'failed' | 'not_needed' },
    authentication: 'checking' as AuthProbeStatus,
    runtimeError: 'none'
  };
}
