import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { createTranslator } from '../src/i18n/index.ts';
import { updateDocumentLanguage } from '../src/i18n/preference.ts';
import {
  conciseAnnouncement,
  hasUnsavedManualEntry,
  statusSymbol,
  viewFocusSelector
} from '../src/views/shared/accessibility.ts';

describe('shared dashboard accessibility', () => {
  test('keeps the active document language accurate', () => {
    const attributes = new Map();
    const documentValue = { documentElement: { setAttribute: (name, value) => attributes.set(name, value) } };
    updateDocumentLanguage('ko', documentValue);
    assert.equal(attributes.get('lang'), 'ko');
    updateDocumentLanguage('en', documentValue);
    assert.equal(attributes.get('lang'), 'en');
  });

  test('provides concise live messages for saves, failures, sync, and conflicts', () => {
    const t = createTranslator('ko');
    assert.equal(conciseAnnouncement({ feedback: '초안이 기기에 기록되었습니다.' }), '초안이 기기에 기록되었습니다.');
    for (const status of ['device_only', 'queued', 'syncing', 'synced', 'failed', 'conflict']) {
      const label = t(`sync.${status === 'device_only' ? 'deviceOnly' : status}`);
      assert.equal(conciseAnnouncement({ status, statusLabel: label }), label);
    }
    assert.equal(conciseAnnouncement({ status: 'cleared', statusLabel: 'ignored' }), '');
  });

  test('communicates status independently of color', () => {
    assert.equal(statusSymbol('success'), '✓');
    assert.equal(statusSymbol('warning'), '!');
    assert.equal(statusSymbol('danger'), '!');
    assert.equal(statusSymbol('unknown'), '•');
  });

  test('defines predictable focus targets and protects unsaved manual entry', () => {
    assert.equal(viewFocusSelector('summary'), '[data-view-heading]');
    assert.equal(viewFocusSelector('auth'), '[data-auth-tab][aria-selected="true"]');
    assert.equal(hasUnsavedManualEntry({ title: '', location: '' }), false);
    assert.equal(hasUnsavedManualEntry({ title: '긴 한국어 유해위험요인 항목명' }), true);
    assert.equal(hasUnsavedManualEntry({ evidencePhotos: [{}] }), true);
  });

  test('includes reduced motion and narrow/high-zoom reflow contracts', async () => {
    const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /\.v2-screen:not\(\.glasses-screen\)/);
    assert.match(css, /@media \(max-width: 520px\)/);
    assert.match(css, /\.report-preview\s*\{[^}]*min-width:\s*0/s);
  });

  test('normal views expose landmarks, named controls, and keyboard-operable auth tabs', async () => {
    const source = await readFile(new URL('../src/workflows/application.ts', import.meta.url), 'utf8');
    assert.match(source, /class="v2-screen[^"$]*" role="main"/);
    assert.match(source, /role="tablist"/);
    assert.match(source, /data-auth-tab role="tab" aria-selected=/);
    assert.match(source, /\['ArrowLeft', 'ArrowRight'\]/);
    assert.match(source, /aria-label="\$\{escapeHtml\(`\$\{worker\.name\}: \$\{t\('attendance\.present'\)\}`\)\}"/);
  });
});
