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

// ─── Auto-retry on 429 rate limit ────────────────────────────────────────────
// Gemini embeds the suggested wait time in the error message: "retry in 49.07s"
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
            if (!is429 || attempt === maxAttempts) throw err;
            // Parse suggested retry delay from error, e.g. "retry in 49.07s"
            const secondsMatch = msg.match(/retry in (\d+\.?\d*)s/i);
            const waitMs = secondsMatch ? Math.min(parseFloat(secondsMatch[1]) * 1000 + 500, 65000) : 20000;
            console.log(`[inpaint] 429 rate limit — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${maxAttempts}`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
    throw new Error('Max retries exceeded');
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

        // Ensure the selected model supports image output
        const modelOption = MODEL_OPTIONS.find(m => m.id === modelId || m.apiModel === modelId);
        if (modelOption && modelOption.type !== 'image') {
            return NextResponse.json({
                error: `"${modelOption.name}" doesn't support image generation. Please switch to an image model (e.g. Gemini 3.1 Flash Image) in the model selector.`
            }, { status: 400 });
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

        const response = await withRetry(() => ai.models.generateContent({
            model: resolveModelId(modelId),
            contents: [{ role: 'user', parts: [...parts, { text: inpaintPrompt }] }],
            config: { responseModalities: ['image', 'text'] },
        }));

        const imagePart = response.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData);
        if (imagePart?.inlineData) {
            const { data: aiData, mimeType: aiMime } = imagePart.inlineData as { data: string; mimeType: string };

            // ── Pixel-exact zone isolation via sharp compositing ──────────────
            // Regardless of what Gemini modified outside the selection, we paste
            // the ORIGINAL pixels back over every black (non-selected) region.
            // This makes the marquee box a true hard guardrail.
            try {
                const sharp = (await import('sharp')).default;
                const origBuf   = Buffer.from(imageBase64, 'base64');
                const aiBuf     = Buffer.from(aiData, 'base64');
                const maskBuf   = Buffer.from(maskBase64, 'base64');

                // Normalise everything to PNG RGBA at the same size as the original
                const { width, height } = await sharp(origBuf).metadata();
                const [origRaw, aiRaw, maskRaw] = await Promise.all([
                    sharp(origBuf).resize(width, height).ensureAlpha().raw().toBuffer(),
                    sharp(aiBuf).resize(width, height).ensureAlpha().raw().toBuffer(),
                    // Mask is greyscale: threshold so anything ≥128 = edit zone (white)
                    sharp(maskBuf).resize(width, height).greyscale().raw().toBuffer(),
                ]);

                // Composite: for each pixel, if mask value < 128 (black = preserve),
                // copy original RGBA; otherwise keep Gemini's RGBA.
                const pixels = width! * height!;
                const out = Buffer.alloc(pixels * 4);
                for (let i = 0; i < pixels; i++) {
                    const isEdited = maskRaw[i] >= 128;
                    const src = isEdited ? aiRaw : origRaw;
                    out[i * 4]     = src[i * 4];
                    out[i * 4 + 1] = src[i * 4 + 1];
                    out[i * 4 + 2] = src[i * 4 + 2];
                    out[i * 4 + 3] = src[i * 4 + 3];
                }

                const composited = await sharp(out, { raw: { width: width!, height: height!, channels: 4 } })
                    .png()
                    .toBuffer();

                console.log('[inpaint] Compositing complete — zone isolation enforced');
                return NextResponse.json({
                    success: true,
                    base64: composited.toString('base64'),
                    mimeType: 'image/png',
                });
            } catch (sharpErr) {
                // If compositing fails for any reason, fall back to raw Gemini output
                console.warn('[inpaint] sharp composite failed, returning raw Gemini output:', sharpErr);
                return NextResponse.json({ success: true, base64: aiData, mimeType: aiMime });
            }
        }

        return NextResponse.json({ error: 'No image returned from Gemini' }, { status: 500 });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[inpaint]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
