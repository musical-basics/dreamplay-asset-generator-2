import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';

// ─── JWT Generation for Kling API ─────────────────────────────────────────────
// Kling uses HMAC-SHA256 JWT with AccessKey + SecretKey
function generateKlingJWT(): string {
    const accessKey = process.env.KLING_ACCESS_KEY;
    const secretKey = process.env.KLING_SECRET_KEY;
    if (!accessKey || !secretKey) throw new Error('KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env.local');

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
        iss: accessKey,
        exp: now + 1800, // 30 min TTL
        nbf: now - 5,    // valid from 5s ago to handle clock skew
    })).toString('base64url');
    const signature = crypto
        .createHmac('sha256', secretKey)
        .update(`${header}.${payload}`)
        .digest('base64url');
    return `${header}.${payload}.${signature}`;
}

const KLING_BASE = 'https://api.klingai.com';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 36; // 36 × 5s = 3 minutes max

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const { prompt, aspectRatio, modelId, brandSuffix, prioritySuffix, campaignMode, imageBase64, imageMimeType } = await req.json();
        const isImageToVideo = !!imageBase64;


        if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });

        const jwt = generateKlingJWT();

        // Map our internal modelId to Kling's model name
        const klingModel = modelId === 'kling-1.6-pro' ? 'kling-v1-6-pro' : 'kling-v1-6';

        // Build guardrail suffix
        const guardrail = ' ⛔ HARD BANS: (1) ZERO yin-yang symbols anywhere. (2) No unauthorized watermarks or text.';
        const pianoOrientation = campaignMode !== 'merch'
            ? ' Piano orientation: bass keys (larger) always on the LEFT, treble keys (smaller) always on the RIGHT. Never mirror/flip.'
            : '';

        const fullPrompt = [
            prompt,
            brandSuffix ?? '',
            prioritySuffix ?? '',
            guardrail,
            pianoOrientation,
        ].filter(Boolean).join(' ').trim();

        // Map aspect ratio (Kling uses "16:9" | "9:16" | "1:1")
        const klingAspect = aspectRatio || '16:9';

        const mode = isImageToVideo ? 'image2video' : 'text2video';
        console.log('[kling] Submitting', mode, '— model:', klingModel, '| aspect:', klingAspect);

        // 1. Submit generation task
        const submitBody = isImageToVideo
            ? {
                model_name: klingModel,
                prompt: fullPrompt,
                image: imageBase64,           // base64 encoded source frame
                duration: '5',
                cfg_scale: 0.5,               // how much motion deviates from base image (0=locked, 1=free)
              }
            : {
                model_name: klingModel,
                prompt: fullPrompt,
                aspect_ratio: klingAspect,
                duration: '5',
                mode: 'std',
              };

        const endpoint = isImageToVideo ? 'image2video' : 'text2video';
        const submitRes = await fetch(`${KLING_BASE}/v1/videos/${endpoint}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${jwt}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(submitBody),
        });

        const submitData = await submitRes.json();
        if (!submitRes.ok || submitData.code !== 0) {
            throw new Error(submitData.message || `Kling submit failed: ${submitRes.status}`);
        }

        const taskId = submitData.data?.task_id;
        if (!taskId) throw new Error('No task_id returned from Kling');

        console.log('[kling] Task submitted:', taskId, '— polling...');

        // 2. Poll until done or failed
        for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

            const pollJwt = generateKlingJWT();
            const pollRes = await fetch(`${KLING_BASE}/v1/videos/${endpoint}/${taskId}`, {
                headers: { 'Authorization': `Bearer ${pollJwt}` },
            });
            const pollData = await pollRes.json();

            if (!pollRes.ok || pollData.code !== 0) {
                throw new Error(pollData.message || 'Kling poll failed');
            }

            const status = pollData.data?.task_status;
            console.log(`[kling] Poll ${i + 1}/${MAX_POLL_ATTEMPTS} — status: ${status}`);

            if (status === 'succeed') {
                const videoUrl = pollData.data?.task_result?.videos?.[0]?.url;
                if (!videoUrl) throw new Error('Kling succeeded but no video URL in response');
                return NextResponse.json({ success: true, videoUrl });
            }

            if (status === 'failed') {
                const reason = pollData.data?.task_status_msg || 'Generation failed';
                throw new Error(`Kling generation failed: ${reason}`);
            }
            // status === 'processing' or 'submitted' → keep polling
        }

        throw new Error('Kling generation timed out after 3 minutes');

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[generate-video-kling]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
