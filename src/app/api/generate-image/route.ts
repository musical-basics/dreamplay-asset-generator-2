import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { MODEL_OPTIONS } from '@/lib/output-formats';

// ─── Model alias resolution ────────────────────────────────────────────────────
// Translates internal UI model IDs (e.g. 'gemini-flash-image-31') to the real
// Gemini API model strings (e.g. 'gemini-3.1-flash-image-preview').
function resolveModelId(id: string): string {
    const found = MODEL_OPTIONS.find(m => m.id === id);
    return found?.apiModel ?? id;
}

// ─── Auto-retry on 429 rate limit ─────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
            if (!is429 || attempt === maxAttempts) throw err;
            const secondsMatch = msg.match(/retry in (\d+\.?\d*)s/i);
            const waitMs = secondsMatch ? Math.min(parseFloat(secondsMatch[1]) * 1000 + 500, 65000) : 20000;
            console.log(`[generate-image] 429 — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${maxAttempts}`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
    throw new Error('Max retries exceeded');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function publicPathToFs(urlPath: string): string {
    return path.join(process.cwd(), 'public', decodeURIComponent(urlPath));
}

async function loadImageAsBase64(fsPath: string): Promise<{ data: string; mimeType: string } | null> {
    try {
        const buf = await readFile(fsPath);
        const ext = path.extname(fsPath).toLowerCase().replace('.', '');
        const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
        };
        const mimeType = mimeMap[ext] ?? 'image/jpeg';
        return { data: buf.toString('base64'), mimeType };
    } catch {
        console.warn('[generate-image] Could not load image:', fsPath);
        return null;
    }
}

// ─── Hardwired brand reference loader ─────────────────────────────────────────
// ALL images inside public/brand-references/ are ALWAYS injected as the first
// reference images in every generation call. Order matters — files are sorted
// alphabetically so name them with a numeric prefix to control priority:
//   01-ds60-topdown.jpg       <- canonical front/top-down product shot
//   02-ds60-angle.jpg         <- 3/4 angle shot
//   03-logo-black.png         <- black logo on white bg
//   04-logo-white.png         <- white logo on dark bg

const BRAND_REF_DIR = path.join(process.cwd(), 'public', 'brand-references');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

async function loadBrandRefs(): Promise<{ data: string; mimeType: string }[]> {
    if (!existsSync(BRAND_REF_DIR)) return [];
    try {
        const files = (await readdir(BRAND_REF_DIR))
            .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
            .sort();  // alphabetical = numeric-prefix ordering
        const loaded = await Promise.all(files.map(f => loadImageAsBase64(path.join(BRAND_REF_DIR, f))));
        return loaded.filter(Boolean) as { data: string; mimeType: string }[];
    } catch {
        return [];
    }
}

// ─── DS 6.0 Master Constraint Prompt ──────────────────────────────────────────
// Injected into EVERY generation. Keep compact — verbose prompts dilute attention.

const DS60_MASTER_CONSTRAINT = `

=== DS 6.0 REFERENCE RULES — THE FIRST IMAGES ARE GROUND TRUTH ===

★ PRIORITY #1 — TEXT & LOGO ACCURACY (NON-NEGOTIABLE):
- The brand name is "DreamPlay" — spelled exactly: capital D, lowercase r-e-a-m, capital P, lowercase l-a-y. Never "Dream Play", "Dreamplay", "DREAMPlay", or any other variation.
- Logo = circular yin-yang emblem + "Dream" (bold italic serif) + "Play" (outline stroke, never filled-in/solid). Both words must be legible and correctly spelled. Treat the logo as pixel-accurate — copy it exactly from the reference image.
- NO extra text, taglines, serial numbers, or model numbers may appear anywhere unless explicitly in the user prompt. Text hallucination is the WORST failure mode.
- White logo on dark backgrounds, black logo on light backgrounds. Never invert this.
- Logo is centered above the key bed on the control panel — do not reposition it.

- CAMERA ANGLE: Match the exact camera angle and perspective from the reference image by default. Only change angle if explicitly instructed in the SPECS below. Do not default to a straight front-on view if the reference shows an angled or 3/4 shot.
- KEYBOARD: 88 keys. Black keys only in groups of 2 or 3, strictly alternating (2-gap-3-gap pattern across full width). Never equal spacing. Never 4+ in one cluster.
- KNOBS: Exactly 2. Round flat-top rubber knobs. Same size, small gap. Top-left of control panel only.
- LCD: 1 rectangular screen (approx 1/6 panel width). Match reference size and position. No added text or graphics.
- CENTER DIAL: Large rotary with alternating rubber arc segments and metallic accent band. Match reference image colors — do not add gold if not shown in reference.
- BUTTONS: 6 rectangular rubber buttons in a compact grid. Match reference colors exactly — do not add metallic accents not in reference.
- GRILLS: Both sides — straight parallel horizontal groove lines only. Left mirrors right. No mesh or perforations.
- GEOMETRY: Do not warp or stretch keyboard body proportions.

===`;

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio, refImagePaths, brandSuffix, prioritySuffix, baseImageBase64, baseImageMimeType } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        if (modelId.startsWith('gemini-')) {
            // 1. Load hardwired brand references (ALWAYS first)
            const brandRefs = await loadBrandRefs();
            const refParts: { inlineData: { data: string; mimeType: string } }[] = [
                ...brandRefs.map(r => ({ inlineData: r })),
            ];

            // 2. Base composition image (for aspect-ratio variants)
            if (baseImageBase64) {
                refParts.push({ inlineData: { data: baseImageBase64, mimeType: baseImageMimeType || 'image/png' } });
            }

            // 3. User-selected reference images (up to additional slots)
            if (Array.isArray(refImagePaths) && refImagePaths.length > 0) {
                const maxUser = Math.max(0, 8 - refParts.length);
                const loaded = await Promise.all(
                    refImagePaths.slice(0, maxUser).map((p: string) => loadImageAsBase64(publicPathToFs(p)))
                );
                for (const img of loaded) {
                    if (img) refParts.push({ inlineData: img });
                }
            }

            // 4. Build prompt
            const ratioHint = aspectRatio && aspectRatio !== '1:1'
                ? ` Compose the image in ${aspectRatio} aspect ratio.`
                : '';

            const refInstruction = refParts.length > 0
                ? ' The FIRST reference images are canonical DS 6.0 product shots — use them as ground truth for ALL product details. Match every element precisely.'
                : '';

            const baseCompInstruction = baseImageBase64
                ? ' One reference image is the base composition — reframe it to the new aspect ratio while preserving all product details.'
                : '';

            const brandInstruction = brandSuffix ? ` ${brandSuffix}` : '';
            const priorityInstruction = prioritySuffix ? ` ${prioritySuffix}` : '';

            const fullPrompt =
                prompt +
                ratioHint +
                baseCompInstruction +
                refInstruction +
                DS60_MASTER_CONSTRAINT +
                brandInstruction +
                priorityInstruction;

            console.log(
                '[generate-image] prompt len:', fullPrompt.length,
                '| brand refs:', brandRefs.length,
                '| user refs:', refImagePaths?.length ?? 0,
                '| base:', !!baseImageBase64,
            );

            const response = await withRetry(() => ai.models.generateContent({
                model: resolveModelId(modelId),
                contents: [{ role: 'user', parts: [...refParts, { text: fullPrompt }] }],
                config: {
                    responseModalities: ['image', 'text'],
                },
            }));

            const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

            if (imagePart?.inlineData) {
                return NextResponse.json({
                    success: true,
                    base64: imagePart.inlineData.data,
                    mimeType: imagePart.inlineData.mimeType,
                });
            }

            return NextResponse.json({ error: 'No image returned from Gemini' }, { status: 500 });

        } else {
            // Imagen (text-to-image only)
            const response = await withRetry(() => ai.models.generateImages({
                model: resolveModelId(modelId),
                prompt,
                config: {
                    numberOfImages: 1,
                    aspectRatio: aspectRatio || '1:1',
                    safetyFilterLevel: 'BLOCK_LOW_AND_ABOVE',
                    personGeneration: 'ALLOW_ADULT',
                } as Parameters<typeof ai.models.generateImages>[0]['config'],
            }));

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
