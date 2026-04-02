import { NextRequest, NextResponse } from 'next/server';
import { enhancePrompt, analyzeReferenceImage } from '@/lib/google-ai';

export async function POST(req: NextRequest) {
    try {
        const { prompt, brandContext, referenceBase64, referenceMimeType, mode } = await req.json();

        if (mode === 'analyze-reference') {
            if (!referenceBase64 || !referenceMimeType) {
                return NextResponse.json({ error: 'Missing reference data' }, { status: 400 });
            }
            const analysis = await analyzeReferenceImage(referenceBase64, referenceMimeType);
            return NextResponse.json({ success: true, analysis });
        }

        // Default: enhance prompt
        if (!prompt) {
            return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
        }

        const enhanced = await enhancePrompt(prompt, brandContext || 'DreamPlay Pianos premium brand');
        return NextResponse.json({ success: true, enhanced });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[enhance-prompt]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
