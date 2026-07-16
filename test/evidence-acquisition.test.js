import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_PROVIDER, EVIDENCE_SOURCE_CATEGORY, isBrowserFulfillmentProvider } from '../src/domain/evidence-acquisition.ts';

test('evidence provider contract keeps native DAT out of browser fulfillment', () => {
  assert.equal(isBrowserFulfillmentProvider(EVIDENCE_PROVIDER.PHONE_BROWSER_CAMERA), true);
  assert.equal(isBrowserFulfillmentProvider(EVIDENCE_PROVIDER.PHONE_BROWSER_GALLERY), true);
  assert.equal(isBrowserFulfillmentProvider(EVIDENCE_PROVIDER.NATIVE_DAT_CAMERA), false);
  assert.equal(EVIDENCE_SOURCE_CATEGORY[EVIDENCE_PROVIDER.PHONE_BROWSER_CAMERA], 'phone_camera');
  assert.equal(EVIDENCE_SOURCE_CATEGORY[EVIDENCE_PROVIDER.PHONE_BROWSER_GALLERY], 'phone_gallery');
  assert.equal(EVIDENCE_SOURCE_CATEGORY[EVIDENCE_PROVIDER.NATIVE_DAT_CAMERA], 'native_glasses_camera');
});
