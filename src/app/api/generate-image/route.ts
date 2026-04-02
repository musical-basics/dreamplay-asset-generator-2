import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';
import { readFile } from 'fs/promises';
import path from 'path';

// Resolve a public-URL path (e.g. /product-images/foo.jpg) to an absolute fs path
function publicPathToFs(urlPath: string): string {
    return path.join(process.cwd(), 'public', decodeURIComponent(urlPath));
}

// Read an image from disk and return base64 + mimeType
async function loadImageAsBase64(urlPath: string): Promise<{ data: string; mimeType: string } | null> {
    try {
        const fsPath = publicPathToFs(urlPath);
        const buf = await readFile(fsPath);
        const ext = path.extname(fsPath).toLowerCase().replace('.', '');
        const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
        };
        const mimeType = mimeMap[ext] ?? 'image/jpeg';
        return { data: buf.toString('base64'), mimeType };
    } catch {
        console.warn('[generate-image] Could not load ref image:', urlPath);
        return null;
    }
}

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio, refImagePaths, brandSuffix, prioritySuffix, baseImageBase64, baseImageMimeType } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        if (modelId.startsWith('gemini-')) {
            // ── Load reference images ─────────────────────────────────────────
            const refParts: { inlineData: { data: string; mimeType: string } }[] = [];
            // If a base composition image is provided (for same-batch variants), prepend it first
            if (baseImageBase64) {
                refParts.push({ inlineData: { data: baseImageBase64, mimeType: baseImageMimeType || 'image/png' } });
            }
            if (Array.isArray(refImagePaths) && refImagePaths.length > 0) {
                const loaded = await Promise.all(
                    refImagePaths.slice(0, baseImageBase64 ? 4 : 5).map((p: string) => loadImageAsBase64(p))
                );
                for (const img of loaded) {
                    if (img) refParts.push({ inlineData: img });
                }
            }

            // Gemini does not accept aspectRatio as a config field — embed in prompt
            const ratioHint = aspectRatio && aspectRatio !== '1:1'
                ? ` Compose the image in ${aspectRatio} aspect ratio.`
                : '';
            const refInstruction = refParts.length > 0
                ? ' The provided reference images define the exact product to generate. ' +
                  'The FIRST reference image is the ground truth for the piano keyboard layout — ' +
                  'copy its exact black key grouping pattern, key proportions, and keyboard structure pixel-for-pixel. ' +
                  'Do NOT deviate from the keyboard layout shown in the first reference image under any circumstances. ' +
                  'Do not hallucinate or invent key arrangements that differ from the reference.'
                : '';
            const brandInstruction = brandSuffix ? ` ${brandSuffix}` : '';
            const priorityInstruction = prioritySuffix ? ` ${prioritySuffix}` : '';
            const baseCompInstruction = baseImageBase64
                ? ' The FIRST reference image is the base composition — reframe it exactly to the new aspect ratio while preserving all product details, scene, and creative choices.'
                : '';

            // ── Hard-wired piano key constraint (always applied) ─────────────
            const pianoConstraint =
                ' MANDATORY PIANO KEYBOARD RULE: A standard piano keyboard has black keys arranged in a strict repeating pattern: ' +
                'TWO black keys clustered together (above D and between C-D-E white keys), then a VISIBLE GAP with no black key (above E), ' +
                'then THREE black keys clustered together (above F-G-A-B white keys), then another VISIBLE GAP (above B). ' +
                'This TWO-black-GAP-THREE-black-GAP pattern repeats identically every octave across the ENTIRE keyboard from left to right. ' +
                'Starting from the left: group of 2 blacks, gap, group of 3 blacks, gap, group of 2 blacks, gap, group of 3 blacks — and so on. ' +
                'DO NOT render all black keys evenly spaced with equal gaps. DO NOT cluster 4 or more black keys in a row. ' +
                'DO NOT make any group have 1 black key. Every group is exactly 2 or exactly 3, alternating. ' +
                'This is the single most important structural detail — get it exactly right.';

            const textPart = { text: prompt + ratioHint + baseCompInstruction + refInstruction + pianoConstraint + brandInstruction + priorityInstruction };
            console.log('[generate-image] prompt len:', textPart.text.length, '| refs:', refParts.length, '| base:', !!baseImageBase64, '| brand:', !!brandSuffix, '| priority:', !!prioritySuffix);

            const response = await ai.models.generateContent({
                model: modelId,
                contents: [{ role: 'user', parts: [...refParts, textPart] }],
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
            // ── Imagen (text-to-image only — refs not supported via this API) ──
            const response = await ai.models.generateImages({
                model: modelId,
                prompt,
                config: {
                    numberOfImages: 1,
                    aspectRatio: aspectRatio || '1:1',
                    safetyFilterLevel: 'BLOCK_LOW_AND_ABOVE',
                    personGeneration: 'ALLOW_ADULT',
                } as Parameters<typeof ai.models.generateImages>[0]['config'],
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
