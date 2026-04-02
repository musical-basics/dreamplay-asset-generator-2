import { BrandConfig } from '@/types';

export const DEFAULT_BRAND_CONFIG: BrandConfig = {
    name: 'DreamPlay Pianos',
    styleWords: ['cinematic', 'luxury', 'premium', 'minimal', 'dark', 'elegant'],
    colors: ['midnight black', 'warm gold', 'deep charcoal', 'ivory white'],
    mood: 'aspirational, high-end, emotionally resonant, modern',
    productType: 'premium digital piano keyboard instrument',
    customPromptSuffix:
        'Studio lighting, sharp product photography, dark moody background, luxury brand aesthetic, high contrast, photorealistic, 8K detail',
};

export const BRAND_STYLE_PRESETS = [
    { label: 'Cinematic Dark', words: ['cinematic', 'moody', 'dark', 'dramatic lighting', 'film noir'] },
    { label: 'Luxury Minimal', words: ['minimal', 'premium', 'clean', 'editorial', 'luxury'] },
    { label: 'Lifestyle Warm', words: ['lifestyle', 'warm', 'cozy', 'aspirational', 'authentic'] },
    { label: 'Product Sharp', words: ['product photo', 'studio lit', 'sharp focus', 'white background', 'commercial'] },
];
