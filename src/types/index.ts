export type OutputCategory = 'social' | 'ads' | 'website' | 'shopify';
export type MediaType = 'image' | 'video';

export interface OutputFormat {
    id: string;
    label: string;
    category: OutputCategory;
    type: MediaType;
    width: number;
    height: number;
    aspectRatio: string;
    duration?: string; // for videos
    notes?: string;
    recommendedModel: string;
    creditEstimate: number; // rough credits
}

export interface ModelOption {
    id: string;
    name: string;
    provider: 'google';
    type: 'image' | 'video' | 'text';
    tier: 'free' | 'paid';
    quality: 'fast' | 'balanced' | 'ultra';
    description: string;
    bestFor: string[];
    creditCost: string;
    apiModel: string;
}

export interface GenerationJob {
    id: string;
    status: 'queued' | 'processing' | 'done' | 'error';
    format: OutputFormat;
    model: ModelOption;
    prompt: string;
    operationName?: string; // for video polling
    resultUrl?: string;
    resultBase64?: string;
    mimeType?: string;
    error?: string;
    createdAt: number;
    completedAt?: number;
}

export interface BrandConfig {
    name: string;
    styleWords: string[];
    colors: string[];
    mood: string;
    productType: string;
    customPromptSuffix: string;
}

export interface ReferenceFile {
    id: string;
    name: string;
    type: 'image' | 'video';
    dataUrl: string;
    mimeType: string;
    analysisResult?: string;
}
