/**
 * Test R2 connection by creating folder markers in dreamplay-assets bucket.
 * Run: pnpm tsx scripts/test-r2-connection.ts
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;

const FOLDERS = [
  'product-images/.keep',
  'generated/.keep',
];

async function main() {
  console.log(`\n🔌 Connecting to R2 bucket: ${BUCKET}\n`);

  // Create folder markers
  for (const key of FOLDERS) {
    const { error } = await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: '',
      ContentType: 'application/octet-stream',
    })).then(() => ({ error: null })).catch(e => ({ error: e }));

    if (error) {
      console.error(`  ❌ Failed to create ${key}:`, (error as Error).message);
    } else {
      console.log(`  ✅ Created ${key}`);
    }
  }

  // List bucket to confirm
  console.log('\n📋 Bucket contents:');
  const list = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  for (const obj of list.Contents ?? []) {
    console.log(`  • ${obj.Key} (${obj.Size} bytes)`);
  }

  console.log('\n✅ R2 connection working!\n');
  console.log(`Public URL base: ${process.env.NEXT_PUBLIC_R2_PUBLIC_URL}`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
