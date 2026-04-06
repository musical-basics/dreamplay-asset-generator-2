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
        const sharp = (await import('sharp')).default;

        // Brand references — keep the model anchored to DS 6.0 truth even during inpaint
        const brandRefs = await loadBrandRefs();

        // ── Context-padded inpainting ─────────────────────────────────────────
        // If the masked zone is very narrow, sending the full image with a tiny
        // white sliver gives Gemini no context — it generates garbage.
        // Solution: crop a padded region around the zone, run Gemini on the crop,
        // then composite only the tight zone pixels back onto the original.

        const origBuf = Buffer.from(imageBase64, 'base64');
        const maskBuf = Buffer.from(maskBase64, 'base64');
        const { width: fullW, height: fullH } = await sharp(origBuf).metadata();
        const W = fullW!, H = fullH!;

        // Find tight bounding box of white pixels in the mask
        const maskGray = await sharp(maskBuf).resize(W, H).greyscale().raw().toBuffer();
        let mx1 = W, my1 = H, mx2 = 0, my2 = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (maskGray[y * W + x] >= 128) {
                    if (x < mx1) mx1 = x; if (x > mx2) mx2 = x;
                    if (y < my1) my1 = y; if (y > my2) my2 = y;
                }
            }
        }

        // Tight zone dims
        const zoneW = Math.max(1, mx2 - mx1 + 1);
        const zoneH = Math.max(1, my2 - my1 + 1);

        // Pad by 2× the zone size on each side so Gemini has context
        const padX = Math.round(zoneW * 2);
        const padY = Math.round(zoneH * 2);
        const cx1 = Math.max(0, mx1 - padX);
        const cy1 = Math.max(0, my1 - padY);
        const cx2 = Math.min(W - 1, mx2 + padX);
        const cy2 = Math.min(H - 1, my2 + padY);
        const cropW = cx2 - cx1 + 1;
        const cropH = cy2 - cy1 + 1;

        const useContextCrop = (zoneW / W) < 0.25 || (zoneH / H) < 0.25;
        console.log(`[inpaint] zone: ${zoneW}×${zoneH}px (${Math.round(zoneW/W*100)}%×${Math.round(zoneH/H*100)}%) | context-crop: ${useContextCrop}`);

        let geminiImageB64: string;
        let geminiMaskB64: string;
        let geminiMime = 'image/png';

        if (useContextCrop) {
            // Crop image and rebuild mask to match the padded crop
            const cropBuf = await sharp(origBuf)
                .extract({ left: cx1, top: cy1, width: cropW, height: cropH })
                .png().toBuffer();
            geminiImageB64 = cropBuf.toString('base64');

            // Rebuild mask: white only where zone overlaps the crop
            const cropCanvas = Buffer.alloc(cropW * cropH).fill(0);
            const relX1 = mx1 - cx1, relY1 = my1 - cy1;
            for (let y = 0; y < zoneH; y++) {
                for (let x = 0; x < zoneW; x++) {
                    cropCanvas[(relY1 + y) * cropW + (relX1 + x)] = 255;
                }
            }
            const cropMaskBuf = await sharp(cropCanvas, { raw: { width: cropW, height: cropH, channels: 1 } })
                .png().toBuffer();
            geminiMaskB64 = cropMaskBuf.toString('base64');
        } else {
            geminiImageB64 = imageBase64;
            geminiMaskB64 = maskBase64;
        }

        const parts: { inlineData: { data: string; mimeType: string } }[] = [
            ...brandRefs.map(r => ({ inlineData: r })),
            { inlineData: { data: geminiImageB64, mimeType: geminiMime } },
            { inlineData: { data: geminiMaskB64, mimeType: 'image/png' } },
        ];

        const inpaintPrompt =
            `You are performing a MASKED INPAINT edit on the provided image.\n\n` +
            `RULES:\n` +
            `1. The SECOND image is the original. The THIRD image is a mask where WHITE pixels mark the ONLY region to edit — BLACK pixels must be reproduced PIXEL-PERFECT.\n` +
            `2. Output the FULL image at the SAME resolution and composition as the input.\n` +
            `3. The surrounding context (black mask region) must be UNCHANGED — only fix what's inside the white box.\n` +
            `4. Reference images are canonical DS 6.0 product shots — use them to correct any product details inside the masked region.\n\n` +
            `TARGETED EDIT (apply ONLY within the white masked region):\n${prompt}\n` +
            (zoneLabel ? `\nZone being edited: ${zoneLabel}` : '');

        console.log('[inpaint] prompt len:', inpaintPrompt.length, '| brand refs:', brandRefs.length);

        const response = await withRetry(() => ai.models.generateContent({
            model: resolveModelId(modelId),
            contents: [{ role: 'user', parts: [...parts, { text: inpaintPrompt }] }],
            config: { responseModalities: ['image', 'text'] },
        }));

        const imagePart = response.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData);
        if (imagePart?.inlineData) {
            const { data: aiData, mimeType: aiMime } = imagePart.inlineData as { data: string; mimeType: string };

            // ── Pixel-exact zone isolation via sharp compositing ──────────────
            // If context-crop was used, Gemini's result is in crop-space.
            // We extract the tight zone from the AI result and paste it back
            // onto the original full image at the correct position.
            try {
                const aiBuf     = Buffer.from(aiData, 'base64');

                const origRaw = await sharp(origBuf).resize(W, H).ensureAlpha().raw().toBuffer();
                const out = Buffer.from(origRaw); // start with original, overwrite only the zone

                if (useContextCrop) {
                    // AI result is in crop-space — extract zone pixels from it
                    const aiCropRaw = await sharp(aiBuf).resize(cropW, cropH).ensureAlpha().raw().toBuffer();
                    const relX1 = mx1 - cx1, relY1 = my1 - cy1;
                    for (let zy = 0; zy < zoneH; zy++) {
                        for (let zx = 0; zx < zoneW; zx++) {
                            const srcIdx = ((relY1 + zy) * cropW + (relX1 + zx)) * 4;
                            const dstIdx = ((my1 + zy) * W + (mx1 + zx)) * 4;
                            out[dstIdx]     = aiCropRaw[srcIdx];
                            out[dstIdx + 1] = aiCropRaw[srcIdx + 1];
                            out[dstIdx + 2] = aiCropRaw[srcIdx + 2];
                            out[dstIdx + 3] = aiCropRaw[srcIdx + 3];
                        }
                    }
                } else {
                    // Full-image mode: composite using mask
                    const aiRaw  = await sharp(aiBuf).resize(W, H).ensureAlpha().raw().toBuffer();
                    const pixels = W * H;
                    for (let i = 0; i < pixels; i++) {
                        if (maskGray[i] >= 128) {
                            out[i * 4]     = aiRaw[i * 4];
                            out[i * 4 + 1] = aiRaw[i * 4 + 1];
                            out[i * 4 + 2] = aiRaw[i * 4 + 2];
                            out[i * 4 + 3] = aiRaw[i * 4 + 3];
                        }
                    }
                }

                const composited = await sharp(out, { raw: { width: W, height: H, channels: 4 } })
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
