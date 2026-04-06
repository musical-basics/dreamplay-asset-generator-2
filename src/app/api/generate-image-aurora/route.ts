import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_BASE_URL = 'https://api.x.ai/v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function publicPathToFs(publicPath: string): string {
    return path.join(process.cwd(), 'public', publicPath.replace(/^\//, ''));
}

// Build a text description of role refs since Aurora's /images/generations
// is text-only (no inline image upload). We inject structured role labels.
function buildRoleRefText(roleRefs: Record<string, string[]> | undefined): string {
    if (!roleRefs) return '';
    const roleLabelMap: Record<string, string> = {
        Product: 'PRODUCT: Replicate the exact piano/keyboard shape, branding, color, and key layout shown.',
        Talent: 'TALENT / ACTOR: CRITICAL – Use the described person\'s exact gender, ethnicity, hair, and features. Do NOT substitute.',
        Background: 'BACKGROUND: Set the scene using the described environment and lighting mood.',
    };
    const parts: string[] = [];
    for (const [role, paths] of Object.entries(roleRefs)) {
        if (!Array.isArray(paths) || paths.length === 0) continue;
        // We can't send image bytes to Aurora text-only endpoint — describe what the role ref slot contains
        const fileNames = paths.map(p => path.basename(p)).join(', ');
        parts.push(`[${roleLabelMap[role] || role}: reference image(s) ${fileNames} provided]`);
    }
    return parts.length ? '\n\nROLE REFERENCES:\n' + parts.join('\n') : '';
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    if (!XAI_API_KEY) {
        return NextResponse.json({ error: 'XAI_API_KEY not configured in .env.local' }, { status: 500 });
    }

    try {
        const {
            prompt,
            aspectRatio,
            roleRefs,
            brandSuffix,
            prioritySuffix,
        } = await req.json();

        if (!prompt) {
            return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
        }

        // Aurora supports standard w×h ratios via response_format or just prompt guidance
        const ratioHint = aspectRatio && aspectRatio !== '1:1'
            ? ` Compose in ${aspectRatio} aspect ratio.`
            : '';

        const roleRefText = buildRoleRefText(roleRefs);
        const brandText = brandSuffix ? ` ${brandSuffix}` : '';
        const priorityText = prioritySuffix ? ` ${prioritySuffix}` : '';

        // Hard brand guardrail
        const guardrail = ' ⛔ HARD BANS: (1) ZERO yin-yang symbols anywhere in the image under any circumstances — not as decor, prop, logo, shadow, or pattern. (2) Piano/keyboard orientation: bass keys (low, larger) always on the LEFT, treble keys (high) always on the RIGHT, control panel on the RIGHT end — never mirrored or flipped. (3) No unauthorized text or watermarks.';

        const fullPrompt = prompt + ratioHint + roleRefText + brandText + priorityText + guardrail;

        console.log('[generate-image-aurora] prompt len:', fullPrompt.length);

        const response = await fetch(`${XAI_BASE_URL}/images/generations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${XAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'aurora',
                prompt: fullPrompt,
                n: 1,
                response_format: 'b64_json',
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: response.statusText }));
            console.error('[generate-image-aurora] API error:', err);
            return NextResponse.json({ error: err?.error?.message || err?.error || response.statusText }, { status: response.status });
        }

        const data = await response.json();
        const b64 = data?.data?.[0]?.b64_json;
        const url = data?.data?.[0]?.url;

        if (b64) {
            return NextResponse.json({ success: true, base64: b64, mimeType: 'image/png' });
        } else if (url) {
            // Fetch and convert to base64
            const imgRes = await fetch(url);
            const buf = await imgRes.arrayBuffer();
            const base64 = Buffer.from(buf).toString('base64');
            const mimeType = imgRes.headers.get('content-type') || 'image/png';
            return NextResponse.json({ success: true, base64, mimeType });
        } else {
            return NextResponse.json({ error: 'No image returned from Aurora' }, { status: 502 });
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[generate-image-aurora] error:', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
