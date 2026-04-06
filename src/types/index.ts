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
    provider: 'google' | 'xai';
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
    batchId: string;       // groups all jobs from one Generate click
    status: 'queued' | 'processing' | 'done' | 'error';
    formatId: string;
    formatLabel: string;
    formatName?: string;
    modelId: string;
    modelName: string;
    prompt: string;
    operationName?: string;
    resultUrl?: string;
    resultBase64?: string;
    mimeType?: string;
    error?: string;
    createdAt: number;
    completedAt?: number;
    feedback?: 'good' | 'bad';  // user rating after generation
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
    dataUrl: string;       // base64 data URL (uploaded) OR public path (preloaded)
    url?: string;          // public URL path for server-hosted images
    mimeType: string;
    analysisResult?: string;
    preloaded?: boolean;   // true = from product library, false/undefined = user-uploaded
}

export interface HistoryEntry {
    id: string;
    prompt: string;
    enhancedPrompt: string;
    refPaths: string[];           // library image paths used
    uploadedRefNames: string[];   // names of uploaded files (no base64 — too large)
    modelId: string;
    modelName: string;
    formatLabels: string[];
    createdAt: number;
}

export interface SavedOutput {
    path: string;          // public URL, e.g. /generated/2026-04-02/abc.png
    fileName: string;
    date: string;          // YYYY-MM-DD
    jobId?: string;
    prompt?: string;
    enhancedPrompt?: string;
    modelId?: string;
    modelName?: string;
    formatLabel?: string;
    aspectRatio?: string;
    refImagePaths?: string[];
    brandSuffix?: string;
    createdAt?: number;
    savedAt?: number;
    feedback?: 'good' | 'bad';
}
