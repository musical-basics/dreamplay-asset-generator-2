import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.thumbcache');
const THUMB_W = 320;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv']);
const MAX_SHARP_BYTES = 50 * 1024 * 1024;
const R2_PUBLIC_URL = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.replace(/\/$/, '') ?? '';

function cacheKey(urlPath: string, w: number): string {
    return crypto.createHash('sha1').update(`${urlPath}:${w}`).digest('hex') + '.webp';
}

export async function GET(req: NextRequest) {
    const { searchParams } = req.nextUrl;
    const urlPath = searchParams.get('path');
    const w = parseInt(searchParams.get('w') || String(THUMB_W), 10);

    if (!urlPath) return NextResponse.json({ error: 'Missing path' }, { status: 400 });

    // ── R2-hosted assets: redirect to CDN URL (with image transform if supported) ──
    // R2 public dev URLs don't support transforms, but the redirect avoids proxying
    if (urlPath.startsWith('https://') || urlPath.startsWith('http://')) {
        return NextResponse.redirect(urlPath, { status: 302 });
    }

    // ── Supabase CDN paths or future cloud paths ──
    if (R2_PUBLIC_URL && urlPath.startsWith(R2_PUBLIC_URL)) {
        return NextResponse.redirect(urlPath, { status: 302 });
    }

    // ── Local path: resolve from public/ or PRODUCT_IMAGES_DIR ──
    let fsPath = path.join(process.cwd(), 'public', decodeURIComponent(urlPath));

    if (!existsSync(fsPath) && process.env.PRODUCT_IMAGES_DIR && urlPath.startsWith('/product-images/')) {
        const rel = decodeURIComponent(urlPath).replace(/^\/product-images\//, '');
        const externalPath = path.join(process.env.PRODUCT_IMAGES_DIR, rel);
        if (externalPath.startsWith(process.env.PRODUCT_IMAGES_DIR) && existsSync(externalPath)) {
            fsPath = externalPath;
        }
    }

    if (!existsSync(fsPath)) return new NextResponse(null, { status: 404 });

    const ext = path.extname(fsPath).toLowerCase();
    if (VIDEO_EXTS.has(ext)) return new NextResponse(null, { status: 415, headers: { 'X-Thumb-Skip': 'video' } });

    let fileSizeBytes = 0;
    try { fileSizeBytes = statSync(fsPath).size; } catch { /* ignore */ }
    if (fileSizeBytes > MAX_SHARP_BYTES) return new NextResponse(null, { status: 413, headers: { 'X-Thumb-Skip': 'too-large' } });

    const thumbName = cacheKey(urlPath, w);
    const thumbPath = path.join(CACHE_DIR, thumbName);

    if (!existsSync(thumbPath)) {
        try {
            const sharp = (await import('sharp')).default;
            await mkdir(CACHE_DIR, { recursive: true });
            const buf = await sharp(fsPath).resize(w, null, { withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
            await writeFile(thumbPath, buf);
        } catch (err) {
            console.warn('[thumb] sharp failed for', path.basename(fsPath), '—', String(err).slice(0, 120));
            return new NextResponse(null, { status: 415, headers: { 'X-Thumb-Skip': 'sharp-error' } });
        }
    }

    const stream = createReadStream(thumbPath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return new NextResponse(Buffer.concat(chunks), {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Thumb-Cache': 'hit' },
    });
}
