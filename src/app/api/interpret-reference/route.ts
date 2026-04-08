import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';

// Gemini 2.5 Pro for highest-quality visual analysis & prompt synthesis
const ANALYSIS_MODEL = 'gemini-2.5-pro-preview-05-06';
const FALLBACK_MODEL  = 'gemini-2.0-flash';          // fallback if 2.5 quota hit

async function runWithFallback(ai: ReturnType<typeof getGoogleAI>, params: Parameters<ReturnType<typeof getGoogleAI>['models']['generateContent']>[0]) {
    try {
        return await ai.models.generateContent({ ...params, model: ANALYSIS_MODEL });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('quota') || msg.includes('429') || msg.includes('not found') || msg.includes('not supported')) {
            console.warn('[interpret-reference] 2.5 Pro unavailable, falling back to 2.0 Flash:', msg);
            return await ai.models.generateContent({ ...params, model: FALLBACK_MODEL });
        }
        throw err;
    }
}

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

            const response = await runWithFallback(ai, {
                model: ANALYSIS_MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { data: imageBase64, mimeType: imageMimeType } },
                        { text: `You are an expert visual analyst and creative director. Study this reference image deeply.

Produce a rich, precise visual analysis structured around these dimensions:

1. **Subject & Composition** — main subject, placement, camera angle, framing, depth
2. **Lighting** — quality, direction, color temperature, shadows, highlights, specular, mood
3. **Color Palette** — dominant hues, tones, saturation levels, contrast, color relationships
4. **Materials & Textures** — surface finishes, material properties, tactile qualities
5. **Background & Environment** — setting, depth, bokeh, environmental elements
6. **Mood & Atmosphere** — emotional register, cinematic style, energy
7. **Technical Photography Style** — lens type feel, depth of field, post-processing look

Be extremely precise and descriptive. Write as rich comma-separated descriptors — language that can be used directly as an image generation prompt foundation. No bullet headers in output.` },
                    ]
                }],
            });

            return NextResponse.json({ success: true, analysis: response.text?.trim() || '', model: ANALYSIS_MODEL });
        }

        // ── Mode 2: Synthesize with brand context (standard mode) ─────────────
        if (mode === 'synthesize') {
            if (!analysis || !modifier) {
                return NextResponse.json({ error: 'Missing analysis or modifier' }, { status: 400 });
            }

            const brand = brandContext || 'DreamPlay Pianos — cinematic, luxury, premium, dark, modern';

            const response = await runWithFallback(ai, {
                model: ANALYSIS_MODEL,
                contents: `You are a creative director synthesizing a final image generation prompt.

You have two inputs:
1. **AI Visual Analysis** (what Gemini sees in the reference image):
${analysis}

2. **Human Direction** (what the creator wants to modify or achieve):
${modifier}

**Your task**: Synthesize these into a single, production-ready generation prompt that:
- Preserves the best visual elements from the reference that the human didn't explicitly change
- Incorporates the human's desired modifications fully
- Applies brand language: ${brand}
- Adds specific lighting, composition, and quality descriptors
- Stays under 200 words
- Is written as a single cohesive prompt (no headers, no lists)

Output ONLY the final synthesized prompt. No explanation, no preamble.`,
            });

            return NextResponse.json({ success: true, synthesis: response.text?.trim() || '', model: ANALYSIS_MODEL });
        }

        // ── Mode 3: PURE synthesize — no brand, no guardrails ────────────────
        if (mode === 'pure-synthesize') {
            if (!analysis || !modifier) {
                return NextResponse.json({ error: 'Missing analysis or modifier' }, { status: 400 });
            }

            const response = await runWithFallback(ai, {
                model: ANALYSIS_MODEL,
                contents: `You are a visual artist synthesizing a clean image generation prompt from a reference photo analysis and human creative direction.

You have two inputs:
1. **Visual Analysis** (what was observed in the reference image):
${analysis}

2. **Human Direction** (what the creator wants to achieve or change):
${modifier}

**Your task**: Write a single, clean image generation prompt that:
- Faithfully captures the visual essence of the reference (lighting, composition, mood, materials, colors)
- Incorporates ALL of the human's creative direction
- Is written as rich, evocative descriptive language
- Contains absolutely NO brand names, product names, restrictions, or negative guards
- Contains NO instructions about what NOT to do
- Is purely additive and descriptive — describe what SHOULD be in the image
- Reads as a natural, fluid creative brief (no lists, no headers, no sections)
- Is 100–180 words

Output ONLY the prompt. No preamble, no explanation, no labels.`,
            });

            return NextResponse.json({ success: true, synthesis: response.text?.trim() || '', model: ANALYSIS_MODEL, mode: 'pure' });
        }

        return NextResponse.json({ error: 'Invalid mode. Use "analyze", "synthesize", or "pure-synthesize"' }, { status: 400 });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[interpret-reference]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
