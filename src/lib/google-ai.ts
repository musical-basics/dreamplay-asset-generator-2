import { GoogleGenAI } from '@google/genai';

let client: GoogleGenAI | null = null;

export function getGoogleAI(): GoogleGenAI {
    if (!client) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey === 'your_gemini_api_key_here') {
            throw new Error('GEMINI_API_KEY is not configured. Add it to .env.local');
        }
        client = new GoogleGenAI({ apiKey });
    }
    return client;
}

export async function enhancePrompt(
    basePrompt: string,
    brandContext: string,
    referenceAnalysis?: string
): Promise<string> {
    const ai = getGoogleAI();
    const systemInstruction = `You are a creative director for DreamPlay Pianos, a premium luxury piano brand. 
Your job is to enhance image/video generation prompts to produce stunning, on-brand marketing assets.
Brand aesthetic: cinematic, dark, luxury, minimal, modern, premium.
Keep prompts under 200 words. Be specific about lighting, composition, mood, and technical quality.`;

    const userContent = `Enhance this prompt for a professional marketing asset:
"${basePrompt}"

Brand context: ${brandContext}
${referenceAnalysis ? `Reference style notes: ${referenceAnalysis}` : ''}

Return ONLY the enhanced prompt, no explanations.`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: userContent,
        config: { systemInstruction },
    });

    return response.text?.trim() || basePrompt;
}

export async function analyzeReferenceImage(
    base64Data: string,
    mimeType: string
): Promise<string> {
    const ai = getGoogleAI();

    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: { data: base64Data, mimeType },
                    },
                    {
                        text: `Analyze this reference image for marketing asset generation. Describe:
1. Color palette and tones
2. Lighting style
3. Composition / subject placement
4. Mood and atmosphere
5. Background style
6. Overall aesthetic style

Be concise, use comma-separated descriptors suitable for image generation prompts.`,
                    },
                ],
            },
        ],
    });

    return response.text?.trim() || '';
}
