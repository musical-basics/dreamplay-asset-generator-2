import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';

const THUMBS_BASE = `/Users/lionelyu/Documents/DreamPlay Assets/Anti-Gravity Projects/dreamplay-media-indexer/.indexer-cache/thumbs`;

export async function GET(req: NextRequest) {
  try {
    const thumbPath = req.nextUrl.searchParams.get('path');
    if (!thumbPath) return NextResponse.json({ error: 'No path' }, { status: 400 });

    // Security: only thumbs from media indexer cache or DreamPlay Assets
    const allowed =
      thumbPath.startsWith(THUMBS_BASE) ||
      thumbPath.startsWith('/Users/lionelyu/Documents/DreamPlay Assets');

    if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!fs.existsSync(thumbPath)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const ext = thumbPath.split('.').pop()?.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const data = fs.readFileSync(thumbPath);

    return new NextResponse(data, {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (err) {
    console.error('[API /media-thumb] Error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
