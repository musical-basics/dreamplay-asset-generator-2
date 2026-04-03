import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Points to the Media Indexer's shared catalog database
const CATALOG_DB_PATH = path.join(
  process.env.HOME || '/Users/lionelyu',
  'Documents/DreamPlay Assets/Anti-Gravity Projects/dreamplay-media-indexer/.indexer-cache/catalog.db'
);

function getDb(): Database.Database | null {
  if (!fs.existsSync(CATALOG_DB_PATH)) return null;
  const db = new Database(CATALOG_DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({
        assets: [],
        total: 0,
        stats: { total: 0, finals: 0, highPriority: 0 },
        notIndexed: true,
      });
    }

    const sp = req.nextUrl.searchParams;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const addFilter = (col: string, val: string | null) => {
      if (val) { conditions.push(`${col} = ?`); params.push(val); }
    };

    addFilter('finalStatus', sp.get('finalStatus'));
    addFilter('subject', sp.get('subject'));
    addFilter('handZone', sp.get('handZone'));
    addFilter('dsModel', sp.get('dsModel'));
    addFilter('purpose', sp.get('purpose'));
    addFilter('campaign', sp.get('campaign'));
    addFilter('shotType', sp.get('shotType'));
    addFilter('colorLabel', sp.get('colorLabel'));
    addFilter('priority', sp.get('priority'));
    addFilter('mediaType', sp.get('mediaType'));
    addFilter('orientation', sp.get('orientation'));

    const search = sp.get('search');
    if (search) {
      conditions.push('(aiDescription LIKE ? OR aiKeywords LIKE ? OR fileName LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q);
    }

    const minDur = sp.get('minDuration');
    const maxDur = sp.get('maxDuration');
    if (minDur) { conditions.push('durationSeconds >= ?'); params.push(parseFloat(minDur)); }
    if (maxDur) { conditions.push('durationSeconds <= ?'); params.push(parseFloat(maxDur)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = parseInt(sp.get('limit') || '200');
    const offset = parseInt(sp.get('offset') || '0');

    const total = (db.prepare(`SELECT COUNT(*) as count FROM assets ${where}`).get(...params) as { count: number }).count;
    const assets = db.prepare(`SELECT * FROM assets ${where} ORDER BY priority DESC, finalStatus ASC, updatedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const stats = {
      total: (db.prepare('SELECT COUNT(*) as count FROM assets').get() as { count: number }).count,
      finals: (db.prepare("SELECT COUNT(*) as count FROM assets WHERE finalStatus = 'final'").get() as { count: number }).count,
      highPriority: (db.prepare("SELECT COUNT(*) as count FROM assets WHERE priority = 'high'").get() as { count: number }).count,
    };

    db.close();
    return NextResponse.json({ assets, total, stats });
  } catch (err) {
    console.error('[API /media-library] Error:', err);
    return NextResponse.json({ error: 'Failed to query media library', assets: [], total: 0, stats: { total: 0, finals: 0, highPriority: 0 } }, { status: 500 });
  }
}
