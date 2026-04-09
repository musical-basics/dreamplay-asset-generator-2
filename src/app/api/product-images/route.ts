import { NextResponse } from 'next/server';
import { assetIndexer } from '@/lib/supabase';

// Fallback: scan local FS if PRODUCT_IMAGES_DIR is set (for dev without R2 table set up yet)
import fs from 'fs';
import path from 'path';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.JPG', '.JPEG', '.PNG', '.WEBP', '.heic', '.HEIC', '.tiff', '.tif', '.JPG']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.MP4', '.MOV']);

export async function GET() {
  try {
    // Primary: query Supabase product_image_catalog (R2-backed)
    const { data, error } = await assetIndexer()
      .from('product_image_catalog')
      .select('storage_path, public_url, folder, name, type')
      .order('folder')
      .order('name');

    if (!error && data && data.length > 0) {
      const grouped: Record<string, { path: string; name: string; type: string }[]> = {};
      for (const row of data) {
        if (!grouped[row.folder]) grouped[row.folder] = [];
        grouped[row.folder].push({ path: row.public_url, name: row.name, type: row.type });
      }
      return NextResponse.json({ grouped, total: data.length, source: 'r2' });
    }

    // Fallback: scan local filesystem (dev mode)
    const PRODUCT_DIR = process.env.PRODUCT_IMAGES_DIR
      || path.join(process.cwd(), 'public', 'product-images');

    const grouped: Record<string, { path: string; name: string; type: string }[]> = {};
    let total = 0;

    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const ext = path.extname(entry.name);
        const isImage = IMAGE_EXTS.has(ext), isVideo = VIDEO_EXTS.has(ext);
        if (!isImage && !isVideo) continue;
        const rel = full.replace(PRODUCT_DIR, '').replace(/\\/g, '/');
        const folder = path.dirname(rel).replace(/^\//, '') || 'Root';
        const filePath = '/product-images' + (rel.startsWith('/') ? rel : '/' + rel);
        if (!grouped[folder]) grouped[folder] = [];
        grouped[folder].push({ path: filePath, name: entry.name, type: isVideo ? 'video' : 'image' });
        total++;
      }
    }
    walk(PRODUCT_DIR);
    return NextResponse.json({ grouped, total, source: 'local' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  // No-op for R2-hosted images (deletion handled separately); kept for API compatibility
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  if (!filePath) return NextResponse.json({ error: 'Missing path' }, { status: 400 });
  return NextResponse.json({ ok: true, note: 'R2 deletion not implemented via UI' });
}
