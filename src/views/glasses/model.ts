export function isGlassesPreview(search: string): boolean {
  return new URLSearchParams(search).get('mode') === 'glasses';
}

export function normalBrowserUrl(currentUrl: string): string {
  const url = new URL(currentUrl);
  url.searchParams.delete('mode');
  return url.toString();
}

export function createMockGlassesEvidence(hazardNumber: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#f2f4f6"/><rect x="22" y="22" width="276" height="136" rx="14" fill="#fff" stroke="#c7ccd3" stroke-width="4"/><circle cx="82" cy="78" r="22" fill="#ff4438" opacity=".88"/><path d="M54 136l62-48 44 34 36-28 70 42H54z" fill="#6f7782" opacity=".72"/><text x="160" y="162" text-anchor="middle" font-family="Arial" font-size="16" fill="#1f252c">Mock evidence</text></svg>`;
  return {
    uploadId: crypto.randomUUID(), originalName: `glasses_mock_evidence_${hazardNumber}.svg`, size: svg.length,
    mimetype: 'image/svg+xml', url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    uploadedAt: new Date().toISOString(), source: 'glasses_mock_capture'
  };
}
