import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        if (modelId === 'gemini-2.0-flash-exp') {
            // Use Gemini image generation
            const response = await ai.models.generateContent({
                model: 'gemini-2.0-flash-exp',
                contents: prompt,
                config: {
                    responseModalities: ['image', 'text'],
                },
            });

            const imagePart = response.candidates?.[0]?.content?.parts?.find(
                (p) => p.inlineData
            );

            if (imagePart?.inlineData) {
                return NextResponse.json({
                    success: true,
                    base64: imagePart.inlineData.data,
                    mimeType: imagePart.inlineData.mimeType,
                });
            }

            return NextResponse.json({ error: 'No image returned from Gemini' }, { status: 500 });
        } else {
            // Use Imagen
            const response = await ai.models.generateImages({
                model: modelId,
                prompt,
                config: {
                    numberOfImages: 1,
                    aspectRatio: aspectRatio || '1:1',
                    safetyFilterLevel: 'BLOCK_LOW_AND_ABOVE',
                    personGeneration: 'ALLOW_ADULT',
                },
            });

            const image = response.generatedImages?.[0];
            if (image?.image?.imageBytes) {
                return NextResponse.json({
                    success: true,
                    base64: image.image.imageBytes,
                    mimeType: 'image/png',
                });
            }

            return NextResponse.json({ error: 'No image returned from Imagen' }, { status: 500 });
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[generate-image]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
