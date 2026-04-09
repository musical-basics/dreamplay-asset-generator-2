/**
 * One-time backfill: reads all JSON sidecars in public/generated/
 * and upserts them into asset_indexer.merch_generations on Supabase.
 *
 * Run: npx tsx scripts/backfill-to-supabase.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { config } from 'dotenv';

// Load .env.local
config({ path: path.join(process.cwd(), '.env.local') });

const GENERATED_DIR = path.join(process.cwd(), 'public', 'generated');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  if (!existsSync(GENERATED_DIR)) {
    console.error('❌ public/generated/ directory not found');
    process.exit(1);
  }

  const dateFolders = (await readdir(GENERATED_DIR, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  let total = 0;
  let upserted = 0;
  let skipped = 0;

  for (const date of dateFolders) {
    const dir = path.join(GENERATED_DIR, date);
    const files = (await readdir(dir)).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

    for (const f of files) {
      total++;
      const baseName = f.replace(/\.[^.]+$/, '');
      const metaPath = path.join(dir, `${baseName}.json`);

      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      } catch {
        console.warn(`  ⚠️  No sidecar for ${date}/${f} — skipping`);
        skipped++;
        continue;
      }

      const ext = f.split('.').pop();
      const row = {
        id:               meta.jobId as string,
        file_path:        `/generated/${date}/${f}`,
        file_name:        f,
        prompt:           (meta.prompt as string) || null,
        enhanced_prompt:  (meta.enhancedPrompt as string) || null,
        model_id:         (meta.modelId as string) || null,
        model_name:       (meta.modelName as string) || null,
        format_label:     (meta.formatLabel as string) || null,
        aspect_ratio:     (meta.aspectRatio as string) || null,
        ref_image_paths:  (meta.refImagePaths as string[]) || [],
        brand_suffix:     (meta.brandSuffix as string) || null,
        feedback:         (meta.feedback as string) || null,
        curation_folder:  null,
        promoted:         false,
        created_at:       (meta.createdAt as number) || Date.now(),
        saved_at:         (meta.savedAt as number) || Date.now(),
        updated_at:       Date.now(),
      };

      const { error } = await supabase
        .schema('asset_indexer')
        .from('merch_generations')
        .upsert(row, { onConflict: 'id' });

      if (error) {
        console.error(`  ❌ Failed to upsert ${date}/${f}:`, error.message);
        skipped++;
      } else {
        console.log(`  ✅ ${date}/${f}`);
        upserted++;
      }
    }
  }

  console.log(`\n── Backfill complete ──`);
  console.log(`   Total files:   ${total}`);
  console.log(`   Upserted:      ${upserted}`);
  console.log(`   Skipped:       ${skipped}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
