import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), '.catalog');
const DB_PATH = path.join(DB_DIR, 'library.db');

export interface CatalogImage {
  id: number;
  filePath: string;   // public URL path  e.g. /product-images/folder/img.jpg
  name: string;
  folder: string;
  type: 'image' | 'video';
  mtime: number;
  size: number;
  indexedAt: number;
}

let _db: Database.Database | null = null;

export function openDb(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS product_images (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      filePath  TEXT UNIQUE NOT NULL,
      name      TEXT NOT NULL,
      folder    TEXT NOT NULL,
      type      TEXT NOT NULL DEFAULT 'image',
      mtime     INTEGER NOT NULL DEFAULT 0,
      size      INTEGER NOT NULL DEFAULT 0,
      indexedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_folder ON product_images(folder);
  `);
  return _db;
}

export function upsertImage(img: Omit<CatalogImage, 'id' | 'indexedAt'>): void {
  const db = openDb();
  db.prepare(`
    INSERT INTO product_images (filePath, name, folder, type, mtime, size, indexedAt)
    VALUES (@filePath, @name, @folder, @type, @mtime, @size, @indexedAt)
    ON CONFLICT(filePath) DO UPDATE SET
      name=excluded.name, folder=excluded.folder, type=excluded.type,
      mtime=excluded.mtime, size=excluded.size, indexedAt=excluded.indexedAt
  `).run({ ...img, indexedAt: Date.now() });
}

export function deleteImage(filePath: string): void {
  openDb().prepare('DELETE FROM product_images WHERE filePath = ?').run(filePath);
}

export function queryGrouped(): {
  grouped: Record<string, { path: string; name: string; type: string }[]>;
  total: number;
} {
  const db = openDb();
  const rows = db.prepare(
    'SELECT filePath, name, folder, type FROM product_images ORDER BY folder, name'
  ).all() as { filePath: string; name: string; folder: string; type: string }[];

  const grouped: Record<string, { path: string; name: string; type: string }[]> = {};
  for (const row of rows) {
    if (!grouped[row.folder]) grouped[row.folder] = [];
    grouped[row.folder].push({ path: row.filePath, name: row.name, type: row.type });
  }
  return { grouped, total: rows.length };
}

export function getCount(): number {
  const db = openDb();
  const row = db.prepare('SELECT COUNT(*) as n FROM product_images').get() as { n: number };
  return row.n;
}

export function getMtime(filePath: string): number {
  const db = openDb();
  const row = db.prepare('SELECT mtime FROM product_images WHERE filePath = ?').get(filePath) as { mtime: number } | undefined;
  return row?.mtime ?? 0;
}
