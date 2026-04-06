import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { readFile } from 'fs/promises';
import { MODEL_OPTIONS } from '@/lib/output-formats';

// ─── Model alias resolution ───────────────────────────────────────────────────
function resolveModelId(id: string): string {
    const found = MODEL_OPTIONS.find(m => m.id === id);
    return found?.apiModel ?? id;
}

const BRAND_REF_DIR = path.join(process.cwd(), 'public', 'brand-references');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

async function loadImageAsBase64(fsPath: string): Promise<{ data: string; mimeType: string } | null> {
    try {
        const buf = await readFile(fsPath);
        const ext = path.extname(fsPath).toLowerCase().replace('.', '');
        const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
        };
        return { data: buf.toString('base64'), mimeType: mimeMap[ext] ?? 'image/png' };
    } catch { return null; }
}

async function loadBrandRefs(): Promise<{ data: string; mimeType: string }[]> {
    if (!existsSync(BRAND_REF_DIR)) return [];
    try {
        const files = (await readdir(BRAND_REF_DIR))
            .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
            .sort();
        const loaded = await Promise.all(files.map(f => loadImageAsBase64(path.join(BRAND_REF_DIR, f))));
        return loaded.filter(Boolean) as { data: string; mimeType: string }[];
    } catch { return []; }
}

/**
 * POST /api/inpaint
 *
 * Body: {
 *   imageBase64: string        // original full image, base64
 *   imageMimeType: string      // e.g. 'image/png'
 *   maskBase64: string         // white=edit, black=keep, base64 PNG
 *   prompt: string             // what to change in the masked region
 *   modelId: string            // gemini model id
 *   zoneLabel?: string         // human-readable zone name for logging
 * }
 *
 * Returns: { base64, mimeType } — same shape as /api/generate-image
 */
export async function POST(req: NextRequest) {
    try {
        const { imageBase64, imageMimeType, maskBase64, prompt, modelId, zoneLabel } = await req.json();

        if (!imageBase64 || !maskBase64 || !prompt || !modelId) {
            return NextResponse.json({ error: 'Missing required fields: imageBase64, maskBase64, prompt, modelId' }, { status: 400 });
        }

        if (!modelId.startsWith('gemini-')) {
            return NextResponse.json({ error: 'Inpainting requires a Gemini model' }, { status: 400 });
        }

        const ai = getGoogleAI();

        // Brand references — keep the model anchored to DS 6.0 truth even during inpaint
        const brandRefs = await loadBrandRefs();

        const parts: { inlineData: { data: string; mimeType: string } }[] = [
            // 1. Brand references first
            ...brandRefs.map(r => ({ inlineData: r })),
            // 2. Original image
            { inlineData: { data: imageBase64, mimeType: imageMimeType || 'image/png' } },
            // 3. Mask (white = region to replace, black = preserve)
            { inlineData: { data: maskBase64, mimeType: 'image/png' } },
        ];

        const inpaintPrompt =
            `You are performing a MASKED INPAINT edit on the provided image.\n\n` +
            `RULES:\n` +
            `1. The SECOND image is the original. The THIRD image is a mask where WHITE pixels mark the region to edit and BLACK pixels mark regions to keep PIXEL-PERFECT.\n` +
            `2. Output the FULL image at the SAME resolution and composition as the original.\n` +
            `3. ONLY modify the white (masked) region — the black region must be reproduced exactly, with NO changes whatsoever.\n` +
            `4. The first reference images are canonical DS 6.0 product references — use them to correct any product details inside the masked region.\n\n` +
            `TARGETED EDIT (apply only within the masked region):\n${prompt}\n` +
            (zoneLabel ? `\nZone: ${zoneLabel}` : '');

        console.log('[inpaint] zone:', zoneLabel, '| prompt len:', inpaintPrompt.length, '| brand refs:', brandRefs.length);

        const response = await ai.models.generateContent({
            model: resolveModelId(modelId),
            contents: [{ role: 'user', parts: [...parts, { text: inpaintPrompt }] }],
            config: { responseModalities: ['image', 'text'] },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return NextResponse.json({
                success: true,
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType,
            });
        }

        return NextResponse.json({ error: 'No image returned from Gemini' }, { status: 500 });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[inpaint]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
