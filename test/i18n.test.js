import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTranslator, normalizeLocale } from '../src/i18n/index.ts';
import {
  LANGUAGE_PREFERENCE_KEY,
  persistLanguage,
  restoreLanguage,
  updateDocumentLanguage
} from '../src/i18n/preference.ts';
import { HAZARD_STATUS, SHARING_STATUS } from '../src/domain/workflow.ts';
import { SYNC_STATUS } from '../src/storage/offline-store.ts';
import { renderSessionReport } from '../server.ts';
import { localizeFinalizationBlocker } from '../src/i18n/workflow.ts';

describe('localization foundation', () => {
  test('uses Korean by default and allows English selection', () => {
    assert.equal(normalizeLocale(undefined), 'ko');
    assert.equal(createTranslator()('hazard.actionRequired'), '조치 필요');
    assert.equal(createTranslator('en')('hazard.actionRequired'), 'Action Required');
  });

  test('falls back predictably and interpolates/counts', () => {
    const english = createTranslator('en');
    assert.equal(english('i18n.fallbackExample'), '한국어 대체 문구');
    assert.equal(english('missing.translation.key'), 'missing.translation.key');
    assert.equal(english('attendance.counts', { present: 3, acknowledged: 1 }),
      '3 present · 1 acknowledgments recorded by supervisor · 0 independently verified');
    assert.equal(english('sessions.count', { count: 1 }), 'You have 1 saved session.');
    assert.equal(english('sessions.count', { count: 2 }), 'You have 2 saved sessions.');
  });

  test('updates document language and restores the persisted non-sensitive preference', () => {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const attributes = new Map();
    const documentValue = { documentElement: { setAttribute: (key, value) => attributes.set(key, value) } };
    persistLanguage('en', storage);
    assert.equal(values.get(LANGUAGE_PREFERENCE_KEY), 'en');
    assert.equal(restoreLanguage(storage), 'en');
    updateDocumentLanguage('en', documentValue);
    assert.equal(attributes.get('lang'), 'en');
  });

  test('never translates language-neutral workflow and sync values', () => {
    assert.equal(HAZARD_STATUS.CONTROLLED, 'controlled');
    assert.equal(HAZARD_STATUS.ACTION_REQUIRED, 'action_required');
    assert.equal(SHARING_STATUS.SHARED, 'shared');
    assert.equal(SYNC_STATUS.CONFLICT, 'conflict');
  });

  test('localizes presentation blockers without changing the domain message', () => {
    const original = 'Hazard 2 (Opening): assigned person is required.';
    assert.equal(localizeFinalizationBlocker(original, createTranslator('ko')), '유해위험요인 2 (Opening): 담당자가 필요합니다.');
    assert.equal(localizeFinalizationBlocker(original, createTranslator('en')), original);
  });

  test('uses representative canonical terminology in Korean and English reports', () => {
    const session = {
      sessionId: 'localized-report', sessionType: 'tbm', site: { siteName: '현장', siteArea: 'A' },
      work: { taskName: '작업' }, supervisor: { name: '감독자', role: 'supervisor' }, workers: [],
      hazards: [{ id: 'h1', title: '개구부', status: 'not_checked', evidencePhotos: [] }], nearMisses: [],
      sharing: { status: 'not_shared', method: '', recipients: '', acknowledgmentResults: '', sharedAt: null }
    };
    const korean = renderSessionReport(session);
    const english = renderSessionReport(session, 'en');
    assert.match(korean, /작업 전 안전회의\(TBM\) 보고서/);
    assert.match(korean, /미종결 시정조치/);
    assert.match(korean, /근로자 공유 증빙/);
    assert.match(english, /Toolbox Meeting \(TBM\) Report/);
    assert.match(english, /Open Corrective Actions/);
    assert.match(english, /Worker Sharing Evidence/);
  });
});
