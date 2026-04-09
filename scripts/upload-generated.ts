/**
 * Upload all generated images to R2 and update merch_generations.file_path
 * to the R2 public URL.
 *
 * Run: pnpm tsx scripts/upload-generated.ts
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { config } from 'dotenv';

config({ path: path.join(process.cwd(), '.env.local') });

const GENERATED_DIR = path.join(process.cwd(), 'public', 'generated');
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

async function main() {
  if (!existsSync(GENERATED_DIR)) {
    console.error('❌ public/generated/ not found');
    process.exit(1);
  }

  const dateFolders = (await readdir(GENERATED_DIR, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  let uploaded = 0, failed = 0;

  for (const date of dateFolders) {
    const dir = path.join(GENERATED_DIR, date);
    const files = (await readdir(dir)).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

    for (const f of files) {
      const absPath = path.join(dir, f);
      const r2Key = `generated/${date}/${f}`;
      const publicUrl = `${PUBLIC_URL_BASE}/${r2Key}`;
      const ext = path.extname(f).toLowerCase();
      const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

      try {
        const buf = await readFile(absPath);
        await r2.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: r2Key,
          Body: buf,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000',
        }));

        // Update merch_generations to point to R2 URL
        const jobId = f.replace(/\.[^.]+$/, '');
        const { error } = await supabase
          .schema('asset_indexer')
          .from('merch_generations')
          .update({ file_path: publicUrl, updated_at: Date.now() })
          .eq('id', jobId);

        if (error) {
          console.warn(`  ⚠️  DB update failed for ${f}: ${error.message}`);
        } else {
          console.log(`  ✅ ${r2Key}`);
          uploaded++;
        }
      } catch (err) {
        console.error(`  ❌ ${f}: ${(err as Error).message}`);
        failed++;
      }
    }
  }

  console.log(`\n── Done ──`);
  console.log(`   Uploaded: ${uploaded}`);
  console.log(`   Failed:   ${failed}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
