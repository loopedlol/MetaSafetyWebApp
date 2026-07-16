export const DEVICE_RUNTIME = Object.freeze({
  BROWSER_PREVIEW: 'browser_preview',
  META_DISPLAY_WEB: 'meta_display_web',
  INVALID: 'invalid'
});

export const DEVICE_ACTION = Object.freeze({
  ADVANCE: 'advance',
  BACK: 'back',
  FOCUS_NEXT: 'focus_next',
  FOCUS_PREVIOUS: 'focus_previous',
  ACTIVATE: 'activate',
  MARK_CONTROLLED: 'mark_controlled',
  MARK_ACTION_REQUIRED: 'mark_action_required',
  CAPTURE_MEMO: 'capture_memo',
  CAPTURE_EVIDENCE: 'capture_evidence',
  TOGGLE_HELP: 'toggle_help'
});

export type DeviceRuntime = typeof DEVICE_RUNTIME[keyof typeof DEVICE_RUNTIME];
export type DeviceAction = typeof DEVICE_ACTION[keyof typeof DEVICE_ACTION];
export type CapabilitySupport = 'supported' | 'mock' | 'unsupported';
export type ConnectionState = 'online' | 'offline';

export interface DeviceCapabilities {
  displayOutput: CapabilitySupport;
  gestureInput: CapabilitySupport;
  cameraPhoto: CapabilitySupport;
  voiceInput: CapabilitySupport;
  connectivity: CapabilitySupport;
  localOfflineStorage: CapabilitySupport;
}

export type CaptureResult<T> =
  | { status: 'captured'; value: T }
  | { status: 'unsupported' | 'permission_denied' | 'failed'; message: string };

export interface DeviceAdapter {
  runtime: DeviceRuntime;
  capabilities: Readonly<DeviceCapabilities>;
  connect(handlers: {
    onAction: (action: DeviceAction, event: KeyboardEvent) => boolean | void;
    onConnectionChange?: (state: ConnectionState) => void;
  }): () => void;
  captureMemo(): Promise<CaptureResult<string>>;
  captureEvidence(context: { hazardNumber: number }): Promise<CaptureResult<unknown>>;
}

type AdapterDependencies = {
  inputTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  connectionTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  isOnline?: () => boolean;
  createPreviewMemo?: () => string;
  createPreviewEvidence?: (hazardNumber: number) => unknown;
};

const META_CAPABILITIES = Object.freeze({
  displayOutput: 'supported',
  gestureInput: 'supported',
  cameraPhoto: 'unsupported',
  voiceInput: 'unsupported',
  connectivity: 'supported',
  localOfflineStorage: 'supported'
}) satisfies Readonly<DeviceCapabilities>;

const PREVIEW_CAPABILITIES = Object.freeze({
  displayOutput: 'mock',
  gestureInput: 'mock',
  cameraPhoto: 'mock',
  voiceInput: 'mock',
  connectivity: 'supported',
  localOfflineStorage: 'supported'
}) satisfies Readonly<DeviceCapabilities>;

const INVALID_CAPABILITIES = Object.freeze({
  displayOutput: 'unsupported',
  gestureInput: 'unsupported',
  cameraPhoto: 'unsupported',
  voiceInput: 'unsupported',
  connectivity: 'unsupported',
  localOfflineStorage: 'unsupported'
}) satisfies Readonly<DeviceCapabilities>;

export function resolveDeviceRuntime(search: string): DeviceRuntime {
  const params = new URLSearchParams(search);
  if (params.get('mode') !== 'glasses') return DEVICE_RUNTIME.BROWSER_PREVIEW;
  const adapter = params.get('adapter');
  if (!adapter || adapter === 'browser-preview') return DEVICE_RUNTIME.BROWSER_PREVIEW;
  if (adapter === 'meta-display') return DEVICE_RUNTIME.META_DISPLAY_WEB;
  return DEVICE_RUNTIME.INVALID;
}

function actionForKey(runtime: DeviceRuntime, key: string): DeviceAction | null {
  if (runtime === DEVICE_RUNTIME.META_DISPLAY_WEB) {
    if (key === 'ArrowRight' || key === 'ArrowDown') return DEVICE_ACTION.FOCUS_NEXT;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return DEVICE_ACTION.FOCUS_PREVIOUS;
    if (key === 'Enter') return DEVICE_ACTION.ACTIVATE;
    if (key === 'Escape') return DEVICE_ACTION.BACK;
    return null;
  }

  if (runtime !== DEVICE_RUNTIME.BROWSER_PREVIEW) return null;

  if (key === 'ArrowRight' || key === 'Enter') return DEVICE_ACTION.ADVANCE;
  if (key === 'ArrowLeft' || key === 'Escape') return DEVICE_ACTION.BACK;
  if (key === '1') return DEVICE_ACTION.MARK_CONTROLLED;
  if (key === '2') return DEVICE_ACTION.MARK_ACTION_REQUIRED;
  if (key.toLowerCase() === 'm') return DEVICE_ACTION.CAPTURE_MEMO;
  if (key.toLowerCase() === 'p') return DEVICE_ACTION.CAPTURE_EVIDENCE;
  if (key === '?' || key.toLowerCase() === 'h') return DEVICE_ACTION.TOGGLE_HELP;
  return null;
}

export function createDeviceAdapter(runtime: DeviceRuntime, dependencies: AdapterDependencies = {}): DeviceAdapter {
  const inputTarget = dependencies.inputTarget ?? window;
  const connectionTarget = dependencies.connectionTarget ?? window;
  const isOnline = dependencies.isOnline ?? (() => navigator.onLine);
  const unsupported = (capability: string): CaptureResult<never> => ({
    status: 'unsupported',
    message: `${capability} is not available in the documented Meta Display Web Apps API.`
  });

  return {
    runtime,
    capabilities: runtime === DEVICE_RUNTIME.META_DISPLAY_WEB
      ? META_CAPABILITIES
      : runtime === DEVICE_RUNTIME.BROWSER_PREVIEW ? PREVIEW_CAPABILITIES : INVALID_CAPABILITIES,
    connect({ onAction, onConnectionChange }) {
      const onKeyDown = (event: Event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (runtime === DEVICE_RUNTIME.META_DISPLAY_WEB && keyboardEvent.repeat) return;
        const action = actionForKey(runtime, keyboardEvent.key);
        if (!action) return;
        if (onAction(action, keyboardEvent) !== false) keyboardEvent.preventDefault();
      };
      const reportConnection = () => onConnectionChange?.(isOnline() ? 'online' : 'offline');
      inputTarget.addEventListener('keydown', onKeyDown);
      connectionTarget.addEventListener('online', reportConnection);
      connectionTarget.addEventListener('offline', reportConnection);
      reportConnection();
      return () => {
        inputTarget.removeEventListener('keydown', onKeyDown);
        connectionTarget.removeEventListener('online', reportConnection);
        connectionTarget.removeEventListener('offline', reportConnection);
      };
    },
    async captureMemo() {
      if (runtime !== DEVICE_RUNTIME.BROWSER_PREVIEW) return unsupported('Voice input');
      try {
        return { status: 'captured', value: dependencies.createPreviewMemo?.() ?? '' };
      } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : 'Preview memo capture failed.' };
      }
    },
    async captureEvidence({ hazardNumber }) {
      if (runtime !== DEVICE_RUNTIME.BROWSER_PREVIEW) return unsupported('Camera/photo access');
      try {
        if (!dependencies.createPreviewEvidence) return { status: 'failed', message: 'Preview evidence factory is unavailable.' };
        return { status: 'captured', value: dependencies.createPreviewEvidence(hazardNumber) };
      } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : 'Preview evidence capture failed.' };
      }
    }
  };
}
