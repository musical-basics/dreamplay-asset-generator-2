import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.thumbcache');
const THUMB_W = 320; // px — enough for the grid, tiny over the wire

function cacheKey(urlPath: string, w: number): string {
    return crypto
        .createHash('sha1')
        .update(`${urlPath}:${w}`)
        .digest('hex') + '.webp';
}

export async function GET(req: NextRequest) {
    const { searchParams } = req.nextUrl;
    const urlPath = searchParams.get('path');   // e.g. /product-images/folder/img.jpg
    const w = parseInt(searchParams.get('w') || String(THUMB_W), 10);

    if (!urlPath) {
        return NextResponse.json({ error: 'Missing path' }, { status: 400 });
    }

    // Security: only serve files inside public/
    const fsPath = path.join(process.cwd(), 'public', decodeURIComponent(urlPath));
    if (!existsSync(fsPath)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Check cache
    const thumbName = cacheKey(urlPath, w);
    const thumbPath = path.join(CACHE_DIR, thumbName);

    if (!existsSync(thumbPath)) {
        // Generate thumbnail using sharp
        try {
            const sharp = (await import('sharp')).default;
            await mkdir(CACHE_DIR, { recursive: true });
            const buf = await sharp(fsPath)
                .resize(w, null, { withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();
            await writeFile(thumbPath, buf);
        } catch (err) {
            // sharp failed (e.g. unsupported format) — stream original
            console.warn('[thumb] sharp failed, streaming original:', err);
            const stream = createReadStream(fsPath);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            const buf = Buffer.concat(chunks);
            return new NextResponse(buf, {
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                },
            });
        }
    }

    // Serve cached thumbnail with a 1-year immutable cache header
    // The browser will NEVER re-request this file — true zero-reload
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
