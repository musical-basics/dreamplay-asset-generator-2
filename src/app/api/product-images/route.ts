import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { queryGrouped, getCount, upsertImage, deleteImage } from '@/lib/catalog';

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
        const rel = full.replace(baseDir, '').replace(/\\/g, '/');
        out.push({ absPath: full, relPath: '/product-images' + rel, name: entry.name,
          folder: path.dirname(rel).replace(/^\//, '') || 'Root', type: isVideo ? 'video' : 'image' });
      }
    }
  }
  walk(dir);
  return out;
}

function autoSeed() {
  const publicDir = path.join(process.cwd(), 'public', 'product-images');
  for (const f of walkDir(publicDir, publicDir)) {
    try {
      const stat = fs.statSync(f.absPath);
      upsertImage({ filePath: f.relPath, name: f.name, folder: f.folder, type: f.type,
        mtime: Math.floor(stat.mtimeMs), size: stat.size });
    } catch { /* skip unreadable files */ }
  }
}

export async function GET() {
  try {
    if (getCount() === 0) autoSeed();
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

    const publicImagesDir = path.resolve(process.cwd(), 'public', 'product-images');
    const absolutePath = path.resolve(process.cwd(), 'public', filePath.replace(/^\//, ''));
    if (!absolutePath.startsWith(publicImagesDir))
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
