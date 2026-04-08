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

const BRAND_REF_DIR     = path.join(process.cwd(), 'public', 'brand-references');
const PERFECT_GEN_DIR   = path.join(process.cwd(), 'public', 'perfect-generations');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

// Loads up to N images from perfect-generations/ as structural ground truth.
// Files are sorted newest-first (by filename timestamp prefix).
async function loadPerfectGenRefs(max = 3): Promise<{ data: string; mimeType: string }[]> {
    if (!existsSync(PERFECT_GEN_DIR)) return [];
    try {
        const files = (await readdir(PERFECT_GEN_DIR))
            .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
            .sort().reverse() // newest first (timestamp prefix)
            .slice(0, max);
        const loaded = await Promise.all(files.map(f => loadImageAsBase64(path.join(PERFECT_GEN_DIR, f))));
        return loaded.filter(Boolean) as { data: string; mimeType: string }[];
    } catch { return []; }
}

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

⛔⛔⛔ PREFLIGHT HARD BANS — CHECK THESE FIRST BEFORE RENDERING ANYTHING:
1. ZERO yin-yang symbols anywhere — not as logo, decor, background prop, shadow, pattern, or abstract shape. If any element resembles a yin-yang, replace it with empty space.
2. PIANO ORIENTATION: Low keys (bass, larger white keys) are ALWAYS on the LEFT side of the frame. High keys (treble, smaller white keys) are ALWAYS on the RIGHT. The control panel (knobs, LCD, buttons) is on the RIGHT end. NEVER mirror/flip/reverse this — a reversed piano is an automatic failure.
3. NEVER add text, watermarks, or labels that are not explicitly in the prompt.
⛔⛔⛔

=== DS 6.0 STRUCTURAL RULES — GROUND TRUTH IMAGES ABOVE ARE THE REFERENCE ===

The first images are PERFECT GENERATION references — study their:
  • Camera angle, perspective, and lighting setup
  • Exact keyboard proportions and key geometry
  • Control panel layout: knob positions, LCD, dial, button grid
  • Speaker grill pattern (straight parallel horizontal grooves)
  • Overall body silhouette and depth

━━ LOCKED (NEVER change, NEVER hallucinate) ━━━━━━━━━━━━━━━━━━━━━━━
• KEYBOARD ANATOMY: 88 keys total. Black keys in strict alternating 2-and-3 groups only.
  The 2-gap-3-gap pattern must repeat precisely across full width. No 4+ in one cluster.
• KNOBS: Exactly 2 round flat-top rubber knobs, same size, small equal gap. Top-left panel only.
• CENTER DIAL: Large rotary with alternating rubber arc segments + metallic accent band. Count segments from reference — do not add or remove.
• BUTTON GRID: Exactly 6 rectangular rubber buttons in a 2×3 compact grid. Count from reference.
• LCD SCREEN: 1 rectangular screen, ~1/6 panel width. Same position as reference. No invented text.
• SPEAKER GRILLS: Both ends — straight parallel horizontal grooves only. Left mirrors right exactly. No mesh.
• BODY PROPORTIONS: Do not stretch, widen, shorten, or warp the chassis.
• LOGO: DreamPlay branded circular emblem (two-tone interlocking swirl shape — absolutely NOT a yin-yang symbol) + "Dream" (bold italic serif) + "Play" (outline stroke). Centered on control panel above key bed. Copy exact design from reference.
• TEXT SPELLING: Always "DreamPlay" — capital D, lowercase ream, capital P, lowercase lay. No variations. No extra text anywhere.
• ORIENTATION: Repeat — bass keys LEFT, treble keys RIGHT, control panel RIGHT end. Never flipped.

━━ VARIABLE (apply from the SPECS below) ━━━━━━━━━━━━━━━━━━━━━━━━━
• Key color / finish (white keys, black keys, gradient options)
• Body / chassis color and surface material
• Background environment and lighting color temperature
• Logo color (white on dark, black on light — maintain contrast)

===`;


// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio, refImagePaths, roleRefs, brandSuffix, prioritySuffix, baseImageBase64, baseImageMimeType, priorityOrder, campaignMode } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        if (modelId.startsWith('gemini-')) {
        const isPure         = campaignMode === 'pure';
        const isProductCampaign = !isPure && campaignMode !== 'merch';

            // Helper: interleave a text label directly before its image(s)
            // This gives Gemini an unambiguous identity mapping: label → pixels
            const parts: { text?: string; inlineData?: { data: string; mimeType: string } }[] = [];
            const addInterleaved = (label: string, refs: ({ data: string; mimeType: string } | null)[]) => {
                const valid = refs.filter(Boolean) as { data: string; mimeType: string }[];
                if (valid.length === 0) return;
                parts.push({ text: label });
                valid.forEach(r => parts.push({ inlineData: r }));
            };

            // 1. Base composition image (aspect-ratio variant source)
            if (baseImageBase64) {
                addInterleaved(
                    '=== BASE COMPOSITION (Reframe to target aspect ratio, preserve all product details) ===',
                    [{ data: baseImageBase64, mimeType: baseImageMimeType || 'image/png' }]
                );
            }

            // 2. Role-specific reference images — ordered by the UI's priorityOrder
            const roleLabelMap: Record<string, string> = {
                Product: 'PRODUCT REFERENCE: Match shape, color, branding, key layout, and physical details exactly. This is the structural anchor.',
                Talent: 'TALENT / ACTOR REFERENCE — CRITICAL IDENTITY LOCK: Replicate exact gender, ethnicity, face, skin tone, hair color/style, and body type with ZERO deviation. Do NOT generate a different person. Do NOT change their gender. Treat this person\'s appearance as a hard constraint equal to product geometry.',
                Background: 'BACKGROUND / SETTING REFERENCE: Replicate the environment, lighting mood, and spatial context exactly.',
            };
            const roleOrder: string[] = Array.isArray(priorityOrder) && priorityOrder.length
                ? priorityOrder
                : ['Product', 'Talent', 'Background'];

            if (roleRefs && typeof roleRefs === 'object') {
                for (const role of roleOrder) {
                    const paths: string[] = Array.isArray(roleRefs[role]) ? roleRefs[role] : [];
                    if (paths.length === 0) continue;
                    const loaded = await Promise.all(paths.slice(0, 2).map((p: string) => loadImageAsBase64(publicPathToFs(p))));
                    addInterleaved(`\n\n=== ${role.toUpperCase()} REFERENCE ===\n${roleLabelMap[role]}`, loaded);
                }
            }

            // 3. Structural ground truth — only for piano/product campaigns (skipped in Pure mode)
            if (isProductCampaign && !isPure) {
                const perfectRefs = await loadPerfectGenRefs();
                addInterleaved(
                    '\n\n=== PIANO GROUND TRUTH (Structural reference — match geometry exactly) ===',
                    perfectRefs
                );
            }

            // 4. Brand assets — skipped in Pure mode
            if (!isPure) {
                const brandRefs = await loadBrandRefs();
                addInterleaved('\n\n=== BRAND ASSETS (Apply logos and brand marks correctly) ===', brandRefs);
            }

            // 5. General user-selected reference images
            if (Array.isArray(refImagePaths) && refImagePaths.length > 0) {
                const loaded = await Promise.all(refImagePaths.slice(0, 4).map((p: string) => loadImageAsBase64(publicPathToFs(p))));
                addInterleaved(
                    '\n\n=== ADDITIONAL USER REFERENCES ===\nThese show the specific subject(s) the user wants in the scene. Preserve their exact appearance — face, body, breed, color, size. Do NOT swap or hallucinate a different subject. Apply only the changes described in the user prompt.',
                    loaded
                );
            }

            // 6. Active constraints block
            const ratioHint = aspectRatio && aspectRatio !== '1:1'
                ? ` Compose the image in ${aspectRatio} aspect ratio.`
                : '';
            const brandInstruction = brandSuffix ? `\nBrand Style: ${brandSuffix}` : '';
            const priorityInstruction = prioritySuffix ? `\nPriority Notes: ${prioritySuffix}` : '';

            let finalPromptText: string;
            if (isPure) {
                // Pure Reference Mode: prompt is used exactly as given, no constraints appended
                finalPromptText = `${prompt}${ratioHint}`;
                console.log('[generate-image] PURE MODE — constraints bypassed, prompt used as-is');
            } else {
                const activeConstraint = isProductCampaign
                    ? DS60_MASTER_CONSTRAINT
                    : `
⛔⛔⛔ PREFLIGHT HARD BANS:
1. ZERO yin-yang symbols anywhere in the image — not as decor, prop, logo, shadow, or pattern.
2. This is a MERCH / APPAREL / LOOKBOOK campaign. Focus entirely on the human talent and the clothing/apparel. Do NOT generate a piano or keyboard unless the user's prompt explicitly requests one.
3. No unauthorized text or watermarks.
⛔⛔⛔`;

                finalPromptText = `[USER PROMPT]\n${prompt}${ratioHint}

[PRIORITIES & BRANDING]${priorityInstruction}${brandInstruction}

[CRITICAL CONSTRAINTS]
${activeConstraint}`;
            }

            parts.push({ text: finalPromptText });

            console.log(
                '[generate-image] campaign:', campaignMode ?? 'product',
                '| priority order:', roleOrder.join('>'),
                '| parts count:', parts.length,
                '| prompt len:', finalPromptText.length,
            );

            const response = await withRetry(() => ai.models.generateContent({
                model: resolveModelId(modelId),
                contents: [{ role: 'user', parts }],
                config: { responseModalities: ['image', 'text'] },
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
