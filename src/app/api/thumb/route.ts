import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.thumbcache');
const THUMB_W = 320; // px — enough for the grid, tiny over the wire

// Video extensions — never try to thumbnail these
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv']);
// Max file size we'll pass to sharp (50 MB)
const MAX_SHARP_BYTES = 50 * 1024 * 1024;

function cacheKey(urlPath: string, w: number): string {
    return crypto
        .createHash('sha1')
        .update(`${urlPath}:${w}`)
        .digest('hex') + '.webp';
}

export async function GET(req: NextRequest) {
    const { searchParams } = req.nextUrl;
    const urlPath = searchParams.get('path');   // relative path
    const source = searchParams.get('source');  // 'external' = PRODUCT_IMAGES_DIR
    const w = parseInt(searchParams.get('w') || String(THUMB_W), 10);

    if (!urlPath) {
        return NextResponse.json({ error: 'Missing path' }, { status: 400 });
    }

    let fsPath: string;
    if (source === 'external' && process.env.PRODUCT_IMAGES_DIR) {
        // Serve from the external local drive folder
        const base = process.env.PRODUCT_IMAGES_DIR;
        fsPath = path.join(base, decodeURIComponent(urlPath));
        // Security: must stay inside PRODUCT_IMAGES_DIR
        if (!fsPath.startsWith(base)) {
            return new NextResponse(null, { status: 403 });
        }
    } else {
        // Default: serve from public/
        fsPath = path.join(process.cwd(), 'public', decodeURIComponent(urlPath));
    }

    if (!existsSync(fsPath)) {
        return new NextResponse(null, { status: 404 });
    }

    // ── Videos: return 415 immediately — never buffer a video into RAM ────────
    const ext = path.extname(fsPath).toLowerCase();
    if (VIDEO_EXTS.has(ext)) {
        return new NextResponse(null, { status: 415, headers: { 'X-Thumb-Skip': 'video' } });
    }

    // ── File size guard: skip sharp for huge files ────────────────────────────
    let fileSizeBytes = 0;
    try { fileSizeBytes = statSync(fsPath).size; } catch { /* ignore */ }
    if (fileSizeBytes > MAX_SHARP_BYTES) {
        return new NextResponse(null, { status: 413, headers: { 'X-Thumb-Skip': 'too-large' } });
    }

    // ── Cache check ───────────────────────────────────────────────────────────
    const thumbName = cacheKey(urlPath, w);
    const thumbPath = path.join(CACHE_DIR, thumbName);

    if (!existsSync(thumbPath)) {
        try {
            const sharp = (await import('sharp')).default;
            await mkdir(CACHE_DIR, { recursive: true });
            const buf = await sharp(fsPath)
                .resize(w, null, { withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();
            await writeFile(thumbPath, buf);
        } catch (err) {
            // sharp failed — return 415, NEVER buffer & stream the original
            console.warn('[thumb] sharp failed for', path.basename(fsPath), '—', String(err).slice(0, 120));
            return new NextResponse(null, { status: 415, headers: { 'X-Thumb-Skip': 'sharp-error' } });
        }
    }

    // ── Serve cached thumbnail ────────────────────────────────────────────────
    const stream = createReadStream(thumbPath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);

    return new NextResponse(buf, {
        headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Thumb-Cache': 'hit',
        },
    });
}
