import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const IMAGE_EXTS = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif',
    '.JPG', '.JPEG', '.PNG', '.WEBP',
]);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.MP4', '.MOV']);

// ── Module-level cache (survives across requests, resets on server restart) ──
let cachedResult: { grouped: Record<string, { path: string; name: string; type: 'image' | 'video' }[]>; total: number } | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000; // 30s — re-scan if files change

function readMediaRecursive(
    dir: string,
    baseDir: string,
    results: { path: string; folder: string; name: string; type: 'image' | 'video' }[] = []
): typeof results {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            readMediaRecursive(fullPath, baseDir, results);
        } else {
            const ext = path.extname(entry.name);
            const isImage = IMAGE_EXTS.has(ext);
            const isVideo = VIDEO_EXTS.has(ext);
            if (isImage || isVideo) {
                const relativePath = fullPath.replace(baseDir, '').replace(/\\/g, '/');
                const folder = path.dirname(relativePath).replace(/^\//, '') || 'Root';
                results.push({
                    path: '/product-images' + relativePath,
                    folder,
                    name: entry.name,
                    type: isVideo ? 'video' : 'image',
                });
            }
        }
    }
    return results;
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const bust = url.searchParams.get('bust');

    // Return cache unless TTL expired or explicit bust
    const now = Date.now();
    if (cachedResult && !bust && now - cacheTime < CACHE_TTL_MS) {
        return NextResponse.json(cachedResult, {
            headers: { 'X-Cache': 'HIT' },
        });
    }

    try {
        const publicDir = path.join(process.cwd(), 'public', 'product-images');
        const media = readMediaRecursive(publicDir, publicDir);

        const grouped: Record<string, { path: string; name: string; type: 'image' | 'video' }[]> = {};
        for (const item of media) {
            if (!grouped[item.folder]) grouped[item.folder] = [];
            grouped[item.folder].push({ path: item.path, name: item.name, type: item.type });
        }

        cachedResult = { grouped, total: media.length };
        cacheTime = now;

        return NextResponse.json(cachedResult, {
            headers: { 'X-Cache': 'MISS' },
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    try {
        const url = new URL(req.url);
        const filePath = url.searchParams.get('path'); // e.g. /product-images/folder/file.jpg

        if (!filePath) return NextResponse.json({ error: 'Missing path' }, { status: 400 });

        // Security: path must be inside public/product-images
        const publicImagesDir = path.resolve(process.cwd(), 'public', 'product-images');
        const absolutePath = path.resolve(process.cwd(), 'public', filePath.replace(/^\//, ''));
        if (!absolutePath.startsWith(publicImagesDir)) {
            return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
        }
        if (!fs.existsSync(absolutePath)) {
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        fs.unlinkSync(absolutePath);

        // Bust cache so next GET re-scans
        cachedResult = null;
        cacheTime = 0;

        return NextResponse.json({ ok: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

