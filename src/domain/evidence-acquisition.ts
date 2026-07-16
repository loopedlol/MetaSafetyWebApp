export const EVIDENCE_PROVIDER = Object.freeze({
  PHONE_BROWSER_CAMERA: 'phone_browser_camera',
  PHONE_BROWSER_GALLERY: 'phone_browser_gallery',
  NATIVE_DAT_CAMERA: 'native_dat_camera'
});

export const EVIDENCE_SOURCE_CATEGORY = Object.freeze({
  [EVIDENCE_PROVIDER.PHONE_BROWSER_CAMERA]: 'phone_camera',
  [EVIDENCE_PROVIDER.PHONE_BROWSER_GALLERY]: 'phone_gallery',
  [EVIDENCE_PROVIDER.NATIVE_DAT_CAMERA]: 'native_glasses_camera'
});

export function isBrowserFulfillmentProvider(value: unknown): boolean {
  return value === EVIDENCE_PROVIDER.PHONE_BROWSER_CAMERA || value === EVIDENCE_PROVIDER.PHONE_BROWSER_GALLERY;
}
