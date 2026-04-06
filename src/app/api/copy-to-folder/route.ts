import { NextRequest, NextResponse } from 'next/server';
import { copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const ALLOWED_TARGETS = new Set(['perfect-generations', 'needs-fixing', 'brand-references']);

/**
 * POST /api/copy-to-folder
 * Body: { sourcePath: string (public URL e.g. /generated/2026-04-06/abc.png), folder: string }
 *
 * Copies an already-on-disk file from public/sourcePath to public/folder/filename.
 * Used when dragging thumbnails from the generated-image grid into the left-panel drop zones.
 */
export async function POST(req: NextRequest) {
    try {
        const { sourcePath, folder } = await req.json();

        if (!sourcePath || !folder) {
            return NextResponse.json({ error: 'Missing sourcePath or folder' }, { status: 400 });
        }
        if (!ALLOWED_TARGETS.has(folder)) {
            return NextResponse.json({ error: `Folder "${folder}" is not allowed` }, { status: 403 });
        }

        // Resolve source — must be inside /public
        const abs = path.join(PUBLIC_DIR, sourcePath);
        if (!abs.startsWith(PUBLIC_DIR) || !existsSync(abs)) {
            return NextResponse.json({ error: 'Source file not found' }, { status: 404 });
        }

        const destDir = path.join(PUBLIC_DIR, folder);
        if (!existsSync(destDir)) await mkdir(destDir, { recursive: true });

        const fileName = path.basename(abs);
        const dest = path.join(destDir, fileName);
        await copyFile(abs, dest);

        return NextResponse.json({ success: true, path: `/${folder}/${fileName}` });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[copy-to-folder]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
