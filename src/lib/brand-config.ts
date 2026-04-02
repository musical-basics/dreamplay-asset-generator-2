import { BrandConfig } from '@/types';

export const DEFAULT_BRAND_CONFIG: BrandConfig = {
    name: 'DreamPlay Pianos',
    styleWords: ['cinematic', 'luxury', 'premium', 'minimal', 'dark', 'elegant'],
    colors: ['midnight black', 'warm gold', 'deep charcoal', 'ivory white'],
    mood: 'aspirational, high-end, emotionally resonant, modern',
    productType: 'premium digital piano keyboard instrument',
    customPromptSuffix:
        // Visual style
        'Studio lighting, sharp product photography, dark moody background, luxury brand aesthetic, high contrast, photorealistic, 8K ultra-detail. ' +
        // Realism + physics — top priority
        'CRITICAL REQUIREMENTS: ' +
        '(1) Hyperrealistic photographic quality — correct light physics, accurate reflections, natural shadows, realistic material surface texture. ' +
        '(2) DreamPlay logo and branding must be clearly visible on the product whenever the piano is shown. ' +
        '(3) Piano keyboard must follow the exact standard layout: black keys alternate in groups of 2 then 3 (2+3+2+3 repeating pattern across the full keyboard). ' +
        'Never render all black keys evenly spaced or in wrong groupings. ' +
        '(4) Key proportions: white keys are taller and wider than black keys; black keys are narrower and raised shorter. ' +
        '(5) Physical consistency: no floating objects, no impossible geometry, no distorted perspective.',
};

export const BRAND_STYLE_PRESETS = [
    { label: 'Cinematic Dark', words: ['cinematic', 'moody', 'dark', 'dramatic lighting', 'film noir'] },
    { label: 'Luxury Minimal', words: ['minimal', 'premium', 'clean', 'editorial', 'luxury'] },
    { label: 'Lifestyle Warm', words: ['lifestyle', 'warm', 'cozy', 'aspirational', 'authentic'] },
    { label: 'Product Sharp', words: ['product photo', 'studio lit', 'sharp focus', 'white background', 'commercial'] },
];
