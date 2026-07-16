import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEVICE_ACTION,
  DEVICE_RUNTIME,
  createDeviceAdapter,
  resolveDeviceRuntime
} from '../src/device/device-adapter.ts';

function keyEvent(key, { repeat = false, type = 'keydown' } = {}) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  Object.defineProperty(event, 'repeat', { value: repeat });
  return event;
}

describe('device adapter contract', () => {
  test('selects the real adapter only with the explicit Meta Display query', () => {
    assert.equal(resolveDeviceRuntime('?mode=glasses'), DEVICE_RUNTIME.BROWSER_PREVIEW);
    assert.equal(resolveDeviceRuntime('?mode=glasses&adapter=meta-display'), DEVICE_RUNTIME.META_DISPLAY_WEB);
    assert.equal(resolveDeviceRuntime('?adapter=meta-display'), DEVICE_RUNTIME.BROWSER_PREVIEW);
    assert.equal(resolveDeviceRuntime('?mode=glasses&adapter=unknown'), DEVICE_RUNTIME.INVALID);
  });

  test('fails closed for an unknown adapter instead of exposing preview actions or capture', async () => {
    const target = new EventTarget();
    const actions = [];
    const adapter = createDeviceAdapter(DEVICE_RUNTIME.INVALID, {
      inputTarget: target, connectionTarget: target, isOnline: () => true,
      createPreviewMemo: () => 'must not be called', createPreviewEvidence: () => ({ source: 'must_not_exist' })
    });
    adapter.connect({ onAction: (action) => actions.push(action) });
    for (const key of ['ArrowRight', 'Enter', '1', '2', 'm', 'p']) target.dispatchEvent(keyEvent(key));
    assert.deepEqual(actions, []);
    assert.equal((await adapter.captureMemo()).status, 'unsupported');
    assert.equal((await adapter.captureEvidence({ hazardNumber: 1 })).status, 'unsupported');
  });

  test('maps only documented D-pad keyboard events in the Meta adapter', () => {
    const target = new EventTarget();
    const actions = [];
    const adapter = createDeviceAdapter(DEVICE_RUNTIME.META_DISPLAY_WEB, {
      inputTarget: target,
      connectionTarget: target,
      isOnline: () => true
    });
    const disconnect = adapter.connect({ onAction: (action) => actions.push(action) });

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', '1', '2', 'm', 'p']) {
      target.dispatchEvent(keyEvent(key));
    }
    disconnect();

    assert.deepEqual(actions, [
      DEVICE_ACTION.FOCUS_PREVIOUS,
      DEVICE_ACTION.FOCUS_NEXT,
      DEVICE_ACTION.FOCUS_PREVIOUS,
      DEVICE_ACTION.FOCUS_NEXT,
      DEVICE_ACTION.ACTIVATE,
      DEVICE_ACTION.BACK
    ]);
    assert.deepEqual(adapter.capabilities, {
      displayOutput: 'supported', gestureInput: 'supported', cameraPhoto: 'unsupported', voiceInput: 'unsupported',
      connectivity: 'supported', localOfflineStorage: 'supported'
    });
  });

  test('emits one action for one Meta keydown and ignores repeats and keyup', () => {
    const target = new EventTarget();
    const actions = [];
    const adapter = createDeviceAdapter(DEVICE_RUNTIME.META_DISPLAY_WEB, {
      inputTarget: target, connectionTarget: target, isOnline: () => true
    });
    const disconnect = adapter.connect({ onAction: (action) => actions.push(action) });
    target.dispatchEvent(keyEvent('ArrowRight'));
    target.dispatchEvent(keyEvent('ArrowRight', { repeat: true }));
    target.dispatchEvent(keyEvent('ArrowRight', { type: 'keyup' }));
    disconnect();
    assert.deepEqual(actions, [DEVICE_ACTION.FOCUS_NEXT]);
  });

  test('reports network changes and removes listeners on disconnect', () => {
    const target = new EventTarget();
    let online = true;
    const states = [];
    const adapter = createDeviceAdapter(DEVICE_RUNTIME.META_DISPLAY_WEB, {
      inputTarget: target, connectionTarget: target, isOnline: () => online
    });
    const disconnect = adapter.connect({ onAction: () => {}, onConnectionChange: (state) => states.push(state) });
    online = false;
    target.dispatchEvent(new Event('offline'));
    disconnect();
    online = true;
    target.dispatchEvent(new Event('online'));
    assert.deepEqual(states, ['online', 'offline']);
  });

  test('keeps preview mocks isolated and refuses camera or voice in the Meta adapter', async () => {
    const preview = createDeviceAdapter(DEVICE_RUNTIME.BROWSER_PREVIEW, {
      inputTarget: new EventTarget(), connectionTarget: new EventTarget(), isOnline: () => true,
      createPreviewMemo: () => 'fixed preview memo',
      createPreviewEvidence: (hazardNumber) => ({ source: 'browser_preview_mock', hazardNumber })
    });
    assert.deepEqual(await preview.captureMemo(), { status: 'captured', value: 'fixed preview memo' });
    assert.deepEqual(await preview.captureEvidence({ hazardNumber: 3 }), {
      status: 'captured', value: { source: 'browser_preview_mock', hazardNumber: 3 }
    });

    const meta = createDeviceAdapter(DEVICE_RUNTIME.META_DISPLAY_WEB, {
      inputTarget: new EventTarget(), connectionTarget: new EventTarget(), isOnline: () => true
    });
    assert.equal((await meta.captureMemo()).status, 'unsupported');
    assert.equal((await meta.captureEvidence({ hazardNumber: 3 })).status, 'unsupported');
  });

  test('returns a failure instead of throwing when a preview capture fails', async () => {
    const adapter = createDeviceAdapter(DEVICE_RUNTIME.BROWSER_PREVIEW, {
      inputTarget: new EventTarget(), connectionTarget: new EventTarget(), isOnline: () => true,
      createPreviewEvidence: () => { throw new Error('capture unavailable'); }
    });
    assert.deepEqual(await adapter.captureEvidence({ hazardNumber: 1 }), { status: 'failed', message: 'capture unavailable' });
  });
});
