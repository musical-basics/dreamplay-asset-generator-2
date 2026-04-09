import { S3Client } from '@aws-sdk/client-s3';

let _r2: S3Client | null = null;

export function getR2(): S3Client {
  if (_r2) return _r2;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY');
  }
  _r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _r2;
}

export const R2_BUCKET = () => {
  const b = process.env.R2_BUCKET_NAME;
  if (!b) throw new Error('Missing R2_BUCKET_NAME');
  return b;
};

export const R2_PUBLIC_URL = () => {
  const u = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
  if (!u) throw new Error('Missing NEXT_PUBLIC_R2_PUBLIC_URL');
  return u.replace(/\/$/, '');
};

export function r2PublicUrl(key: string): string {
  return `${R2_PUBLIC_URL()}/${key}`;
}
