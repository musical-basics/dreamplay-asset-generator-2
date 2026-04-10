/**
 * POST /api/agent/generate
 *
 * Single-call endpoint for external AI agents to trigger a full generation.
 * Handles: generate → R2 upload → Supabase save → return CDN URL
 *
 * Auth: x-api-key header must match AGENT_API_KEY env var
 *
 * Request body:
 * {
 *   "prompt": string,                   // required
 *   "modelId": string,                  // optional, default: gemini-3.1-flash-image-preview
 *   "aspectRatio": string,              // optional, default: "1:1"
 *   "campaignMode": "product"|"merch",  // optional, default: "merch"
 *   "refImageUrls": string[],           // optional, R2/CDN URLs to use as references
 *   "formatLabel": string               // optional, label for the generation
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "id": string,
 *   "url": string,        // R2 public CDN URL
 *   "prompt": string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAI } from '@/lib/google-ai';
import { assetIndexer } from '@/lib/supabase';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const R2_BUCKET    = process.env.R2_BUCKET_NAME ?? '';
const R2_PUBLIC    = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.replace(/\/$/, '') ?? '';
const AGENT_KEY    = process.env.AGENT_API_KEY ?? '';
const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';

// ── helpers ────────────────────────────────────────────────────────────────────

function getR2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

/** Fetch an image from a URL and return base64 + mimeType */
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct  = res.headers.get('content-type') || 'image/jpeg';
    return { data: buf.toString('base64'), mimeType: ct.split(';')[0] };
  } catch {
    console.warn('[agent/generate] Could not fetch ref image:', url);
    return null;
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err: unknown) {
      const msg   = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
      if (!is429 || attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 20000));
    }
  }
  throw new Error('Max retries exceeded');
}

// Merch-mode constraint (no piano guardrails)
const MERCH_CONSTRAINT = `
⛔ HARD BANS:
1. ZERO yin-yang symbols anywhere.
2. MERCH / LOOKBOOK campaign — focus on apparel and talent. Do NOT add a piano unless the prompt explicitly asks for one.
3. No watermarks or unauthorized text.`;

// ── route ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth
  const apiKey = req.headers.get('x-api-key');
  if (!AGENT_KEY || apiKey !== AGENT_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      prompt,
      modelId       = DEFAULT_MODEL,
      aspectRatio   = '1:1',
      campaignMode  = 'merch',
      refImageUrls  = [] as string[],
      formatLabel   = 'Agent Generation',
    } = body as {
      prompt:        string;
      modelId?:      string;
      aspectRatio?:  string;
      campaignMode?: string;
      refImageUrls?: string[];
      formatLabel?:  string;
    };

    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });

    // ── 1. Load reference images from URLs ──────────────────────────────────
    const parts: { text?: string; inlineData?: { data: string; mimeType: string } }[] = [];

    if (refImageUrls.length > 0) {
      const loaded = (await Promise.all(refImageUrls.slice(0, 4).map(fetchImageAsBase64))).filter(Boolean) as { data: string; mimeType: string }[];
      if (loaded.length > 0) {
        parts.push({ text: '=== REFERENCE IMAGES ===' });
        loaded.forEach(r => parts.push({ inlineData: r }));
      }
    }

    // ── 2. Final prompt ─────────────────────────────────────────────────────
    const ratioHint    = aspectRatio !== '1:1' ? ` Compose in ${aspectRatio} aspect ratio.` : '';
    const constraint   = campaignMode === 'merch' ? MERCH_CONSTRAINT : '';
    const finalPrompt  = `[USER PROMPT]\n${prompt}${ratioHint}\n\n[CONSTRAINTS]${constraint}`;
    parts.push({ text: finalPrompt });

    // ── 3. Generate ─────────────────────────────────────────────────────────
    const ai = getGoogleAI();
    const response = await withRetry(() =>
      ai.models.generateContent({
        model:    modelId,
        contents: [{ role: 'user', parts }],
        config:   { responseModalities: ['image', 'text'] },
      })
    );

    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData) {
      return NextResponse.json({ error: 'No image returned from model' }, { status: 500 });
    }

    const { data: base64, mimeType } = imagePart.inlineData;
    if (!base64) return NextResponse.json({ error: 'Empty image data from model' }, { status: 500 });
    const ext     = (mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
    const jobId   = `${Date.now()}_agent_${Math.random().toString(36).slice(2, 8)}`;
    const today   = new Date().toISOString().slice(0, 10);
    const r2Key   = `generated/${today}/${jobId}.${ext}`;
    const r2Url   = `${R2_PUBLIC}/${r2Key}`;
    const imgBuf  = Buffer.from(base64, 'base64');

    // ── 4. Upload to R2 ─────────────────────────────────────────────────────
    await getR2().send(new PutObjectCommand({
      Bucket:       R2_BUCKET,
      Key:          r2Key,
      Body:         imgBuf,
      ContentType:  `image/${ext}`,
      CacheControl: 'public, max-age=31536000',
    }));

    // ── 5. Save to Supabase ─────────────────────────────────────────────────
    const now = Date.now();
    const { error: dbErr } = await assetIndexer()
      .from('merch_generations')
      .upsert({
        id:              jobId,
        file_path:       r2Url,
        file_name:       `${jobId}.${ext}`,
        prompt,
        model_id:        modelId,
        model_name:      modelId,
        format_label:    formatLabel,
        aspect_ratio:    aspectRatio,
        ref_image_paths: refImageUrls,
        created_at:      now,
        saved_at:        now,
        updated_at:      now,
      }, { onConflict: 'id' });

    if (dbErr) console.error('[agent/generate] Supabase write failed:', dbErr.message);

    return NextResponse.json({ success: true, id: jobId, url: r2Url, prompt });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent/generate]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
