export interface AiSuggestion {
  title: string;
  category: string;
  riskLevel: 'low' | 'medium' | 'high';
  description: string;
  recommendedAction: string;
  confidence: number | null;
}

export interface AnalysisProviderResult {
  mode: string;
  provider: string;
  modelVersion: string | null;
  pixelInterpretation: boolean;
  simulated: boolean;
  disclaimer: string;
  suggestion: AiSuggestion;
}

export interface AnalysisProvider {
  analyze(input: { entryType: 'new_hazard' | 'near_miss'; upload: Record<string, unknown>; imageBytes: Buffer }):
    Promise<AnalysisProviderResult>;
}

const FIXTURES: Record<string, AiSuggestion> = Object.freeze({
  new_hazard: Object.freeze({
    title: 'Potential blocked access or housekeeping hazard',
    category: 'site_housekeeping',
    riskLevel: 'medium',
    description: 'Deterministic mock fixture for a possible access or housekeeping hazard.',
    recommendedAction: 'Have a qualified person inspect the area, select appropriate controls, and document the human decision.',
    confidence: 0.74
  }),
  near_miss: Object.freeze({
    title: 'Near miss requiring human review',
    category: 'near_miss_observation',
    riskLevel: 'high',
    description: 'Deterministic mock fixture for a possible near-miss condition.',
    recommendedAction: 'Pause related work as appropriate and require a qualified person to review conditions before deciding next steps.',
    confidence: 0.78
  })
});

export function createMockAnalysisProvider(): AnalysisProvider {
  return {
    async analyze({ entryType }) {
      return {
        mode: 'mock',
        provider: 'deterministic_fixture',
        modelVersion: 'fixture-v1',
        pixelInterpretation: false,
        simulated: true,
        disclaimer: 'Simulated fixture only. Image pixels were not interpreted.',
        suggestion: { ...FIXTURES[entryType] }
      };
    }
  };
}

export function createAnalysisProvider(mode = 'mock'): AnalysisProvider {
  if (!mode || mode === 'mock') return createMockAnalysisProvider();
  throw new Error(`Unsupported AI_MODE "${mode}". No external image-analysis provider is configured.`);
}

export function normalizeProviderResult(value: AnalysisProviderResult): AnalysisProviderResult {
  if (!value || typeof value !== 'object' || !value.suggestion || (value.simulated && value.pixelInterpretation !== false)) {
    throw new Error('Analysis provider returned an invalid result.');
  }
  const suggestion = value.suggestion;
  if (![suggestion.title, suggestion.category, suggestion.riskLevel, suggestion.description, suggestion.recommendedAction]
    .every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('Analysis provider returned an incomplete suggestion.');
  }
  if (!['low', 'medium', 'high'].includes(suggestion.riskLevel)) throw new Error('Analysis provider returned an invalid risk level.');
  return {
    mode: String(value.mode), provider: String(value.provider), modelVersion: value.modelVersion ? String(value.modelVersion) : null,
    pixelInterpretation: value.pixelInterpretation === true, simulated: value.simulated === true,
    disclaimer: String(value.disclaimer ?? ''), suggestion: { ...suggestion }
  };
}
