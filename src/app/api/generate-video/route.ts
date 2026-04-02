import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio, durationSeconds } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        const operation = await ai.models.generateVideos({
            model: modelId,
            prompt,
            config: {
                aspectRatio: aspectRatio || '16:9',
                durationSeconds: durationSeconds || 5,
            },
        });

        // Return the operation name for polling
        return NextResponse.json({
            success: true,
            operationName: operation.name,
            done: operation.done,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[generate-video]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
