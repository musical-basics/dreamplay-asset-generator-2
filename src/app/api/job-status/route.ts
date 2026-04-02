import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';

export async function POST(req: NextRequest) {
    try {
        const { operationName } = await req.json();

        if (!operationName) {
            return NextResponse.json({ error: 'Missing operationName' }, { status: 400 });
        }

        const ai = getGoogleAI();
        const operation = await ai.operations.get({ operation: operationName });

        if (!operation.done) {
            return NextResponse.json({ done: false });
        }

        if (operation.error) {
            return NextResponse.json({ done: true, error: operation.error.message });
        }

        const video = operation.response?.generatedVideos?.[0];
        if (video?.video?.uri) {
            return NextResponse.json({
                done: true,
                videoUri: video.video.uri,
                mimeType: 'video/mp4',
            });
        }

        return NextResponse.json({ done: true, error: 'No video in response' });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[job-status]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
