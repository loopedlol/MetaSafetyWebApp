# Localization

Safety Lens uses a small dependency-free i18n layer:

- `src/i18n/catalog.ts`: stable Korean and English message keys and canonical terminology.
- `src/i18n/index.ts`: locale normalization, Korean fallback, interpolation, and English count selection.
- `src/i18n/preference.ts`: `safety-lens-language` preference and document `lang` updates.
- `src/i18n/workflow.ts`: presentation-only localization of unchanged domain finalization blockers.

Korean (`ko`) is the default. English (`en`) can be selected from the normal browser header or authentication screen. The selected language is stored in `localStorage` because it is a tiny, non-sensitive UI preference. IndexedDB safety records, API values, and user-entered text are not changed.

Canonical Korean terminology:

- hazard: `유해위험요인`
- controlled: `통제됨`
- action required: `조치 필요`
- corrective action: `시정조치`
- attendance: `출석`
- supervisor-recorded acknowledgment: `감독자 기록 TBM 확인`
- independently verified acknowledgment: `독립적으로 검증된 근로자 확인`
- synchronization: `동기화`
- worker sharing evidence: `근로자 공유 증빙`
- draft: `초안`
- finalization: `최종 확정`

Intentionally untranslated:

- the product marks `Safety Lens`, `V2`, and `Beta`;
- user-entered site, task, worker, hazard, memo, corrective-action, and sharing text;
- database/API identifiers and enum values shown in copied raw JSON;
- rare raw backend validation, authentication, throttling, and internal diagnostic details. Frontend fallback messages are localized, but server-provided diagnostic text remains unchanged to preserve API contracts;
- the developer-only `?stress=1` layout-test memo.

Printable reports and report-not-found pages default to Korean and accept `?lang=en`. The browser opens reports with its currently selected language.
