/**
 * Upload product images to R2 (excluding WebPage Layouts/)
 * and index them into asset_indexer.product_image_catalog.
 *
 * Run: pnpm tsx scripts/upload-product-images.ts
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { config } from 'dotenv';

config({ path: path.join(process.cwd(), '.env.local') });

const PRODUCT_DIR = process.env.PRODUCT_IMAGES_DIR
  || path.join(process.cwd(), 'public', 'product-images');

const BUCKET = process.env.R2_BUCKET_NAME!;
const PUBLIC_URL_BASE = process.env.NEXT_PUBLIC_R2_PUBLIC_URL!.replace(/\/$/, '');
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } }
);

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.tiff', '.tif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi']);

// Folders to exclude
const EXCLUDE_FOLDERS = ['WebPage Layouts'];

function mimeType(ext: string): string {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
    '.heic': 'image/heic', '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
    '.webm': 'video/webm', '.avi': 'video/avi',
  };
  return m[ext.toLowerCase()] || 'application/octet-stream';
}

interface FileEntry {
  absPath: string;
  r2Key: string;   // product-images/Interior Backgrounds/hallway3.avif
  folder: string;  // Interior Backgrounds
  name: string;
  type: 'image' | 'video';
}

async function walk(dir: string, baseDir: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const relFromBase = path.relative(baseDir, full);
    const topFolder = relFromBase.split(path.sep)[0];
    if (EXCLUDE_FOLDERS.some(ex => topFolder.includes(ex))) continue;

    if (e.isDirectory()) {
      results.push(...await walk(full, baseDir));
    } else {
      const ext = path.extname(e.name).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      if (!isImage && !isVideo) continue;

      const rel = path.relative(baseDir, full).replace(/\\/g, '/');
      results.push({
        absPath: full,
        r2Key: `product-images/${rel}`,
        folder: path.dirname(rel).replace(/\\/g, '/') || 'Root',
        name: e.name,
        type: isVideo ? 'video' : 'image',
      });
    }
  }
  return results;
}

async function main() {
  if (!existsSync(PRODUCT_DIR)) {
    console.error(`❌ PRODUCT_DIR not found: ${PRODUCT_DIR}`);
    process.exit(1);
  }

  console.log(`\n📁 Scanning: ${PRODUCT_DIR}`);
  console.log(`⛔ Excluding: ${EXCLUDE_FOLDERS.join(', ')}\n`);

  const files = await walk(PRODUCT_DIR, PRODUCT_DIR);
  console.log(`Found ${files.length} files to upload\n`);

  let uploaded = 0, skipped = 0, failed = 0;

  for (const f of files) {
    try {
      const stats = await stat(f.absPath);
      const buf = await readFile(f.absPath);
      const ext = path.extname(f.name).toLowerCase();

      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: f.r2Key,
        Body: buf,
        ContentType: mimeType(ext),
        CacheControl: 'public, max-age=31536000',
      }));

      const publicUrl = `${PUBLIC_URL_BASE}/${encodeURIComponent(f.r2Key).replace(/%2F/g, '/')}`;

      const { error } = await supabase
        .schema('asset_indexer')
        .from('product_image_catalog')
        .upsert({
          storage_path: f.r2Key,
          public_url:   publicUrl,
          folder:       f.folder,
          name:         f.name,
          type:         f.type,
          size_bytes:   stats.size,
          indexed_at:   Date.now(),
        }, { onConflict: 'storage_path' });

      if (error) {
        console.warn(`  ⚠️  DB upsert failed for ${f.name}: ${error.message}`);
      } else {
        console.log(`  ✅ ${f.r2Key}`);
        uploaded++;
      }
    } catch (err) {
      console.error(`  ❌ ${f.name}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n── Done ──`);
  console.log(`   Uploaded: ${uploaded}`);
  console.log(`   Skipped:  ${skipped}`);
  console.log(`   Failed:   ${failed}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
