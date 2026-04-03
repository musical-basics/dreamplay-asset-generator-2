import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { upsertImage, getMtime } from '@/lib/catalog';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.JPG', '.JPEG', '.PNG', '.WEBP']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.MP4', '.MOV']);

function walkDir(
  dir: string,
  baseDir: string,
  out: { absPath: string; relPath: string; name: string; folder: string; type: 'image' | 'video' }[] = []
) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, baseDir, out);
    } else {
      const ext = path.extname(entry.name);
      const isImage = IMAGE_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      if (isImage || isVideo) {
        const rel = full.replace(baseDir, '').replace(/\\/g, '/');
        const folder = path.dirname(rel).replace(/^\//, '') || 'Root';
        out.push({
          absPath: full,
          relPath: '/product-images' + rel,
          name: entry.name,
          folder,
          type: isVideo ? 'video' : 'image',
        });
      }
    }
  }
  return out;
}

export async function POST() {
  try {
    const publicDir = path.join(process.cwd(), 'public', 'product-images');
    const files = walkDir(publicDir, publicDir);

    let indexed = 0;
    let skipped = 0;

    for (const f of files) {
      const stat = fs.statSync(f.absPath);
      const mtime = Math.floor(stat.mtimeMs);
      const storedMtime = getMtime(f.relPath);

      if (mtime === storedMtime) {
        skipped++;
        continue;
      }

      upsertImage({
        filePath: f.relPath,
        name: f.name,
        folder: f.folder,
        type: f.type,
        mtime,
        size: stat.size,
      });
      indexed++;
    }

    return NextResponse.json({ ok: true, indexed, skipped, total: files.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[index-library]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
