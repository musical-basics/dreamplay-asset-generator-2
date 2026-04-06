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
• LOGO: DreamPlay branded circular emblem (two-tone interlocking swirl shape — do NOT render as a generic yin-yang symbol) + "Dream" (bold italic serif) + "Play" (outline stroke). Centered on control panel above key bed. Copy the exact design from the reference image.
• TEXT SPELLING: Always "DreamPlay" — capital D, lowercase ream, capital P, lowercase lay. No variations. No extra text anywhere.

⛔ ABSOLUTE HARD BANS — Never under any circumstances:
• NEVER generate a yin-yang symbol anywhere in the image (not as decor, logo interpretation, background element, or pattern)
• NEVER add text, watermarks, or labels that are not in the prompt

━━ VARIABLE (apply from the SPECS below) ━━━━━━━━━━━━━━━━━━━━━━━━━
• Key color / finish (white keys, black keys, gradient options)
• Body / chassis color and surface material
• Background environment and lighting color temperature
• Logo color (white on dark, black on light — maintain contrast)

===`;


// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const { prompt, modelId, aspectRatio, refImagePaths, roleRefs, brandSuffix, prioritySuffix, baseImageBase64, baseImageMimeType } = await req.json();

        if (!prompt || !modelId) {
            return NextResponse.json({ error: 'Missing prompt or modelId' }, { status: 400 });
        }

        const ai = getGoogleAI();

        if (modelId.startsWith('gemini-')) {
            // 1. Perfect-generation ground truth (ALWAYS first — structural reference)
            const [perfectRefs, brandRefs] = await Promise.all([loadPerfectGenRefs(), loadBrandRefs()]);
            const refParts: { inlineData: { data: string; mimeType: string } }[] = [
                ...perfectRefs.map(r => ({ inlineData: r })),
                ...brandRefs.map(r => ({ inlineData: r })),
            ];

            // 2. Base composition image (for aspect-ratio variants)
            if (baseImageBase64) {
                refParts.push({ inlineData: { data: baseImageBase64, mimeType: baseImageMimeType || 'image/png' } });
            }

            // 3. Role-specific reference images (Product / Talent / Background)
            let roleRefInstruction = '';
            const roleLabelMap: Record<string, string> = {
                Product: 'PRODUCT REFERENCE — This image shows the exact product (piano/keyboard). Match its shape, color, branding, key layout, and physical details precisely. This is the primary layout anchor.',
                Talent: 'TALENT / ACTOR REFERENCE — CRITICAL IDENTITY LOCK. This image shows THE SPECIFIC PERSON who must appear in the final image. You MUST replicate: their exact gender, face, skin tone, hair color/style, and body type with zero deviation. Do NOT generate a different person, do NOT change their gender, do NOT use a generic or stock face. The person in this reference IS the talent — treat their appearance as a hard constraint identical to product geometry.',
                Background: 'BACKGROUND / SETTING REFERENCE — This image defines the scene, environment, and atmosphere. Replicate the key visual elements, lighting mood, and spatial context.',
            };
            if (roleRefs && typeof roleRefs === 'object') {
                const roleOrder: string[] = ['Product', 'Talent', 'Background'];
                for (const role of roleOrder) {
                    const paths: string[] = Array.isArray(roleRefs[role]) ? roleRefs[role] : [];
                    if (paths.length === 0) continue;
                    const maxSlots = Math.max(0, 8 - refParts.length);
                    if (maxSlots <= 0) break;
                    const loaded = await Promise.all(
                        paths.slice(0, Math.min(2, maxSlots)).map((p: string) => loadImageAsBase64(publicPathToFs(p)))
                    );
                    let added = 0;
                    for (const img of loaded) {
                        if (img) { refParts.push({ inlineData: img }); added++; }
                    }
                    if (added > 0) {
                        roleRefInstruction += `\n\n=== ${role.toUpperCase()} REFERENCE (LAST ${added} IMAGE${added > 1 ? 'S' : ''} ABOVE) ===\n${roleLabelMap[role]}\n===`;
                    }
                }
            }

            // 4. General user-selected reference images
            let userRefInstruction = '';
            if (Array.isArray(refImagePaths) && refImagePaths.length > 0) {
                const maxUser = Math.max(0, 8 - refParts.length);
                const loaded = await Promise.all(
                    refImagePaths.slice(0, maxUser).map((p: string) => loadImageAsBase64(publicPathToFs(p)))
                );
                let addedCount = 0;
                for (const img of loaded) {
                    if (img) { refParts.push({ inlineData: img }); addedCount++; }
                }
                if (addedCount > 0) {
                    userRefInstruction = `\n\n=== USER SUBJECT REFERENCES (LAST ${addedCount} IMAGE${addedCount > 1 ? 'S' : ''} ABOVE) ===\nThese images show the SPECIFIC SUBJECT(S) the user wants in the scene.\n- PRESERVE the exact appearance of the person, animal, or object shown: face, body, breed, color, size.\n- Do NOT swap, replace, or hallucinate a different subject.\n- Apply ONLY the changes described in the user prompt (e.g. add clothing, change background, add product).\n- The subject's identity must be recognizable and consistent with the reference.\n===`;
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
                roleRefInstruction +
                userRefInstruction +
                DS60_MASTER_CONSTRAINT +
                brandInstruction +
                priorityInstruction;

            console.log(
                '[generate-image] prompt len:', fullPrompt.length,
                '| perfect refs:', perfectRefs.length,
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
