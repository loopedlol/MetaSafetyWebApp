# Native Meta DAT evidence capture

This is a controlled pilot integration, not a certified safety or evidence system. The Meta Display Web App cannot access the glasses camera directly. It creates a scoped server request; the separately authorized Android companion uses Meta Wearables DAT Android `0.8.0` to capture the photo.

```text
Meta Display Web App (restricted TBM cookie)
  -> create request -> explicit Capture confirmation -> mark ready
Safety Lens API (server time, owner scope, atomic lease)
  <- low-frequency poll / claim -> Android device credential
Android foreground service -> existing DAT session/stream -> Stream.capturePhoto()
  -> app-private JPEG -> claimed-request upload -> private evidence store
Meta Display Web App <- Photo received -> explicit Attach photo
```

The domain workflow does not depend on DAT. `native_dat_camera` is an evidence provider alongside the retained `phone_browser_camera` and `phone_browser_gallery` fallbacks. Only the Android companion assigns upload provenance `sdk_raw_camera`; provenance does not prove scene authenticity.

## Register and revoke a device

1. Sign in as a supervisor in the normal Safety Lens browser.
2. In **Native camera devices**, name the phone and create an eight-digit one-time code. It expires after five minutes and is returned only on creation.
3. Configure and start the Android companion as described in its README. Enter the code under **Safety Lens native capture**.
4. The Android app exchanges the code in a request body. It stores the returned credential encrypted with an Android Keystore AES-GCM key; the server stores only an HMAC digest.
5. Refresh the browser panel to see name and last-seen time. Use **Revoke** before reassigning, losing, or retiring a phone. Revocation rejects its next request and releases active claims.

The device credential is not a supervisor or glasses credential. It can only inspect its own registration, poll/claim assigned native requests, report bounded status, upload to its own claim, and complete it. It cannot list TBMs, download uploads, use AI, make hazard decisions, attach evidence, or manage accounts/pairings/devices.

## Capture, cancellation, and retake

1. On Meta Display choose **Take photo**. If no non-revoked device is registered, the control remains unavailable and no capture is simulated.
2. Review **Camera preparation**, look at the hazard, then explicitly choose **Confirm capture**. Polling alone never makes a request capturable.
3. Android atomically claims the request, verifies the existing DAT session, glasses connection, DAT camera permission, and streaming state, then calls `Stream.capturePhoto()` exactly once for that attempt.
4. Android re-encodes the DAT result as JPEG in `filesDir/safety_lens_captures/<request-id>.jpg`, shows an app preview, uploads it only to that claim, and deletes it after server confirmation.
5. Meta Display shows only received status. **Attach photo** is a separate explicit action and the later human hazard confirmation remains mandatory.
6. **Retake** supersedes only a completed, unattached result and creates a fresh request. Attached evidence cannot be replaced by this route.
7. **Cancel** makes pending completion invalid and releases an active claim. Android deletes a persisted temporary file when it observes cancellation/expiry; files older than 24 hours are also removed on coordinator startup.

Claims use server timestamps and expire leases. Network loss after capture preserves the request/file/upload identity for retry, preventing a different capture from being uploaded to that request. A process death in the narrow interval after DAT capture but before private-file persistence can require a new attempt after lease expiry; this remains a pilot risk.

## Private image policy

Native uploads retain the existing 5 MB maximum, byte-signature MIME detection, owner checks, opaque server filenames, mode `0600`, and authenticated download route. Android filenames and paths are ignored and never written to request/audit logs. Images are not put in Gallery or sent to any third-party/cloud image service.

Android re-encodes the decoded bitmap as JPEG, which normally omits source EXIF metadata. The server does not independently strip or inspect EXIF, so operators must not rely on metadata removal as a formal guarantee and must not use EXIF location for decisions.

## API and data model

- Supervisor: `POST /api/native-devices/registrations`, `GET /api/native-devices`, `DELETE /api/native-devices/:deviceId`.
- One-time exchange: `POST /api/native-devices/register`.
- Restricted glasses: availability, create, ready, status, cancel, retake, and attach routes under `/api/glasses/`.
- Native device: own status and next/claim/status/upload/complete routes under `/api/native/`.
- Migration `008_native_dat_devices.sql` adds one-time registrations, credential digests, devices, claims/leases, readiness, and supersession metadata.

## Physical-device checklist

Automated tests verify authorization, digest-only storage, revocation, readiness gating, atomic claims, private upload linkage, idempotent completion, browser unavailability, no Meta `getUserMedia`, explicit attachment, recovery identity, and Android debug compilation. A real phone/glasses test is still required to verify:

- Meta AI registration, firmware compatibility, DAT permission, connected session, and stream transition to `STREAMING`;
- no camera activity before the Meta Display **Confirm capture** action;
- a new glasses-camera image appears in the Android app preview and no public-gallery copy exists;
- private upload, **Photo received**, retake, attach, cross-TBM isolation, cancellation during capture, and device revocation;
- foreground notification visibility and service stop behavior on the target Android version.

Do not record real workplace evidence until every physical item is signed off by the pilot owner.
