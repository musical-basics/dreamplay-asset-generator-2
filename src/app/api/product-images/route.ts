import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { queryGrouped, getCount, upsertImage, deleteImage, getMtime } from '@/lib/catalog';

// ── Fallback: seed SQLite from disk if DB is empty ─────────────────────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.JPG', '.JPEG', '.PNG', '.WEBP']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.MP4', '.MOV']);

function walkDir(dir: string, baseDir: string) {
  const out: { absPath: string; relPath: string; name: string; folder: string; type: 'image' | 'video' }[] = [];
  if (!fs.existsSync(dir)) return out;
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = path.extname(entry.name);
      const isImage = IMAGE_EXTS.has(ext), isVideo = VIDEO_EXTS.has(ext);
      if (isImage || isVideo) {
        // Store a pure relative path (no leading slash, no hardcoded prefix)
        const rel = full.replace(baseDir, '').replace(/\\/g, '/').replace(/^\//, '');
        const folder = path.dirname(rel) || 'Root';
        out.push({ absPath: full, relPath: rel, name: entry.name, folder, type: isVideo ? 'video' : 'image' });
      }
    }
  }
  walk(dir);
  return out;
}

// ── Source directory: env var or fallback to public/product-images ──────────
const PRODUCT_DIR = process.env.PRODUCT_IMAGES_DIR
  || path.join(process.cwd(), 'public', 'product-images');

// Whether the dir is inside public/ (static serving) or external (needs /api/thumb)
const IS_PUBLIC_DIR = PRODUCT_DIR.startsWith(path.join(process.cwd(), 'public'));

function imageRelPath(absPath: string): string {
  const rel = absPath.replace(PRODUCT_DIR, '').replace(/\\/g, '/');
  if (IS_PUBLIC_DIR) return '/product-images' + rel;
  // External path: route through thumb API for serving
  return '/api/thumb?path=' + encodeURIComponent(rel) + '&source=external';
}

function autoSeed() {
  for (const f of walkDir(PRODUCT_DIR, PRODUCT_DIR)) {
    try {
      const stat = fs.statSync(f.absPath);
      const mtime = Math.floor(stat.mtimeMs);
      if (getMtime(f.absPath) === mtime) continue;
      // Store absPath as the key; serve via imageRelPath
      upsertImage({ filePath: imageRelPath(f.absPath), name: f.name, folder: f.folder, type: f.type,
        mtime, size: stat.size });
    } catch { /* skip unreadable files */ }
  }
}

export async function GET() {
  try {
    autoSeed();
    const result = queryGrouped();
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const filePath = url.searchParams.get('path');
    if (!filePath) return NextResponse.json({ error: 'Missing path' }, { status: 400 });

    const absolutePath = path.resolve(PRODUCT_DIR, filePath.replace(/^\//, ''));
    if (!absolutePath.startsWith(PRODUCT_DIR))
      return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
    if (!fs.existsSync(absolutePath))
      return NextResponse.json({ error: 'File not found' }, { status: 404 });

    fs.unlinkSync(absolutePath);
    deleteImage(filePath);

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
