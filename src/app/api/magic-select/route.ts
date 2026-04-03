import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';

/**
 * POST /api/magic-select
 *
 * Body: {
 *   imageBase64: string        // full image, base64
 *   imageMimeType: string
 *   description: string        // e.g. "the DreamPlay logo" or "the piano keys"
 * }
 *
 * Returns: { x, y, w, h } normalized 0–1 from top-left of the bounding box,
 *           or { error } if detection failed.
 */
export async function POST(req: NextRequest) {
    try {
        const { imageBase64, imageMimeType, description } = await req.json();

        if (!imageBase64 || !description) {
            return NextResponse.json({ error: 'Missing imageBase64 or description' }, { status: 400 });
        }

        const ai = getGoogleAI();

        const detectPrompt =
            `Analyze this image and find the bounding box of: "${description}".\n\n` +
            `Return ONLY valid JSON in this exact format (no markdown, no explanation):\n` +
            `{"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.3}\n\n` +
            `Where x, y, w, h are all floating-point values between 0 and 1:\n` +
            `- x = left edge of the bounding box (0 = far left, 1 = far right)\n` +
            `- y = top edge of the bounding box (0 = top, 1 = bottom)\n` +
            `- w = width of the bounding box as a fraction of total image width\n` +
            `- h = height of the bounding box as a fraction of total image height\n\n` +
            `If you cannot find the described region, return: {"error": "not found"}\n` +
            `Be precise. Only return the JSON object.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { data: imageBase64, mimeType: imageMimeType || 'image/png' } },
                    { text: detectPrompt },
                ],
            }],
        });

        const text = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim() ?? '';

        console.log('[magic-select] description:', description, '| raw response:', text.slice(0, 200));

        // Strip any markdown code fences if present
        const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

        let parsed: { x?: number; y?: number; w?: number; h?: number; error?: string };
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return NextResponse.json({ error: `Could not parse model response: ${cleaned.slice(0, 100)}` }, { status: 500 });
        }

        if (parsed.error) {
            return NextResponse.json({ error: parsed.error }, { status: 404 });
        }

        const { x, y, w, h } = parsed;
        if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') {
            return NextResponse.json({ error: 'Invalid bounding box values' }, { status: 500 });
        }

        // Clamp to [0, 1]
        return NextResponse.json({
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y)),
            w: Math.max(0.01, Math.min(1 - x, w)),
            h: Math.max(0.01, Math.min(1 - y, h)),
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[magic-select]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
