import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

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
//   01-ds60-topdown.jpg       ← canonical front/top-down product shot
//   02-ds60-angle.jpg         ← 3/4 angle shot
//   03-logo-black.png         ← black logo on white bg
//   04-logo-white.png         ← white logo on dark bg

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
// This is injected into EVERY generation regardless of user prompt.
// Study the brand-references images and replicate EVERY detail below exactly.

const DS60_MASTER_CONSTRAINT = `

=== DS 6.0 HARD RULES — DO NOT DEVIATE FROM ANY OF THESE ===

[1] PIANO KEYBOARD — MANDATORY:
The keyboard has 88 keys. Black keys follow a STRICT alternating pattern: TWO black keys clustered together, then a VISIBLE GAP (no black key), then THREE black keys clustered together, then another VISIBLE GAP. This 2-GAP-3-GAP pattern repeats across the ENTIRE keyboard left to right without exception. Never render equal-spaced black keys. Never cluster 4 or more. Every group is EXACTLY 2 or EXACTLY 3, alternating. Copy this pattern exactly from the reference image.

[2] LOGO — DO NOT HALLUCINATE:
The DreamPlay logo consists of: a circular icon (two overlapping "D" shapes forming a yin-yang-like emblem) on the LEFT, followed by "Dream" in bold sans-serif italic and "Play" in outline/stroke italic font. The logo sits centered below the control panel, above the keys. Use the BLACK logo version on light backgrounds and LIGHT/WHITE logo version on dark backgrounds. Do NOT invent any other logo design, do NOT add subtitle text, do NOT resize or reposition it. Copy it EXACTLY as shown in the brand reference images.

[3] TWO KNOBS (top-left of control panel):
There are exactly TWO round black rubber knobs. Left knob = SOUND. Right knob = VOLUME. They are the same size, same style (flat-top black knurled cylinder). The gap between them is consistent and small. They sit in the upper-left region of the control panel. Do NOT change their shape, style, size, or add more knobs.

[4] CENTER LCD DISPLAY:
There is a single rectangular LCD screen roughly 1/6 of the panel width. It has a blue-tinted backlit display showing minimal text/icons. Do NOT resize it. Do NOT add new text, icons, or UI elements that are not in the reference. Do NOT hallucinate a larger, different, or reimagined screen. Copy its size, shape, position, and content EXACTLY from the reference image.

[5] CENTER DIAL (large rotary control):
There is one large circular dial to the right of the LCD. Its design is: a rubber ring divided into alternating black and white rubber segments around its perimeter, with a gold metallic center band/ring. Do NOT change this design. Do NOT make it a generic silver knob. The rubber portions are matte, the gold band is metallic/shiny. Study the reference carefully and replicate every detail.

[6] SIX RECTANGULAR RUBBER BUTTONS (right of LCD group):
There are exactly 6 small rectangular buttons arranged in a grid (2 rows × 3 cols, or similar compact layout). Five buttons are matte black rubber. One button is GOLD metallic. Do NOT add extra buttons. Do NOT change button shapes to circles or rounded-rect. Do NOT hallucinate labels or LEDs not in the reference. Copy the exact number, layout, and materials from the reference.

[7] SPEAKER GRILLS (far left and far right of the control panel strip):
On each far side there is a speaker grill. The grill consists of clean, straight, parallel horizontal lines/slots — NOT mesh, NOT dots, NOT organic blobs. Study the exact number of horizontal groove lines, the spacing between them, and whether they are embossed (raised) or debossed (recessed). The left and right grills are MIRROR IMAGES of each other — perfectly symmetrical. The grill material matches the matte black body of the piano casing (NOT chrome or metallic). Replicate the groove pattern exactly: same line count, same column structure, same emboss/deboss direction.

=== END DS 6.0 HARD RULES ===
`;

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio, refImagePaths, brandSuffix, prioritySuffix, baseImageBase64, baseImageMimeType } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        if (modelId.startsWith('gemini-')) {
            // ── 1. Load hardwired brand references (ALWAYS first) ──────────────
            const brandRefs = await loadBrandRefs();
            const refParts: { inlineData: { data: string; mimeType: string } }[] = [
                ...brandRefs.map(r => ({ inlineData: r })),
            ];

            // ── 2. Base composition image (for aspect-ratio variants) ──────────
            if (baseImageBase64) {
                refParts.push({ inlineData: { data: baseImageBase64, mimeType: baseImageMimeType || 'image/png' } });
            }

            // ── 3. User-selected reference images (up to 4 additional) ─────────
            if (Array.isArray(refImagePaths) && refImagePaths.length > 0) {
                const maxUser = Math.max(0, 8 - refParts.length); // keep total ≤ 8
                const loaded = await Promise.all(
                    refImagePaths.slice(0, maxUser).map((p: string) => loadImageAsBase64(publicPathToFs(p)))
                );
                for (const img of loaded) {
                    if (img) refParts.push({ inlineData: img });
                }
            }

            // ── 4. Build prompt ────────────────────────────────────────────────
            const ratioHint = aspectRatio && aspectRatio !== '1:1'
                ? ` Compose the image in ${aspectRatio} aspect ratio.`
                : '';

            const refInstruction = refParts.length > 0
                ? ' The FIRST reference images are the canonical DS 6.0 product shots — ground truth for ALL product details. ' +
                  'Every element of the product (keyboard, logo, knobs, LCD, dial, buttons, speaker grills) must match the reference images exactly. ' +
                  'Do not deviate from any detail shown in the reference under any circumstances.'
                : '';

            const baseCompInstruction = baseImageBase64
                ? ' One reference image is the base composition — reframe it exactly to the new aspect ratio while preserving all product details.'
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

            const response = await ai.models.generateContent({
                model: modelId,
                contents: [{ role: 'user', parts: [...refParts, { text: fullPrompt }] }],
                config: {
                    responseModalities: ['image', 'text'],
                },
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
