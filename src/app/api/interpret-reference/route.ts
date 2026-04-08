import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';

const MODEL = 'gemini-2.0-flash';

// ─── Route ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
    try {
        const { mode, imageBase64, imageMimeType, analysis, modifier, brandContext } = await req.json();
        const ai = getGoogleAI();

        // ── Mode 1: Analyze reference image ──────────────────────────────────
        if (mode === 'analyze') {
            if (!imageBase64 || !imageMimeType) {
                return NextResponse.json({ error: 'Missing image data' }, { status: 400 });
            }

            const response = await ai.models.generateContent({
                model: MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { data: imageBase64, mimeType: imageMimeType } },
                        { text: `You are a creative director and visual analyst for DreamPlay Pianos, a premium luxury brand.

Analyze this reference image in detail and produce a structured visual analysis for use in AI image generation.

Describe the following with precision:
1. **Subject & Composition** — what is the main subject, how is it placed, camera angle, framing
2. **Lighting** — quality, direction, color temperature, shadows, highlights, mood
3. **Color Palette** — dominant colors, tones, saturation, contrast
4. **Background & Environment** — setting, depth, bokeh, textures
5. **Mood & Atmosphere** — emotional tone, style (cinematic, editorial, lifestyle, etc.)
6. **Technical Style** — photography style, post-processing look, depth of field

Be precise and descriptive. Use language that translates directly into effective generation prompts. No bullet headers in output — write as rich, comma-separated descriptors ready for use as a prompt foundation.` },
                    ]
                }],
            });

            return NextResponse.json({ success: true, analysis: response.text?.trim() || '' });
        }

        // ── Mode 2: Synthesize analysis + human modifier ──────────────────────
        if (mode === 'synthesize') {
            if (!analysis || !modifier) {
                return NextResponse.json({ error: 'Missing analysis or modifier' }, { status: 400 });
            }

            const brand = brandContext || 'DreamPlay Pianos — cinematic, luxury, premium, dark, modern';

            const response = await ai.models.generateContent({
                model: MODEL,
                contents: `You are a creative director for DreamPlay Pianos synthesizing a final image generation prompt.

You have two inputs:
1. **AI Visual Analysis** (what Gemini sees in the reference image):
${analysis}

2. **Human Direction** (what the creator wants to modify or achieve):
${modifier}

**Your task**: Synthesize these into a single, production-ready generation prompt that:
- Preserves the best visual elements from the reference that the human didn't explicitly change
- Incorporates the human's desired modifications fully
- Applies DreamPlay brand language: ${brand}
- Adds specific lighting, composition, and quality descriptors
- Stays under 200 words
- Is written as a single cohesive prompt (no headers, no lists)

Output ONLY the final synthesized prompt. No explanation, no preamble.`,
            });

            return NextResponse.json({ success: true, synthesis: response.text?.trim() || '' });
        }

        return NextResponse.json({ error: 'Invalid mode. Use "analyze" or "synthesize"' }, { status: 400 });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[interpret-reference]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
