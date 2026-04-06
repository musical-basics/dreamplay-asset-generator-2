import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const ALLOWED_FOLDERS = new Set(['perfect-generations', 'needs-fixing']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const folder = formData.get('folder') as string;
        const files = formData.getAll('files') as File[];

        if (!folder || !ALLOWED_FOLDERS.has(folder)) {
            return NextResponse.json({ error: 'Invalid folder' }, { status: 400 });
        }
        if (!files || files.length === 0) {
            return NextResponse.json({ error: 'No files provided' }, { status: 400 });
        }

        const targetDir = path.join(process.cwd(), 'public', folder);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const saved: string[] = [];
        for (const file of files) {
            const ext = path.extname(file.name).toLowerCase();
            if (!IMAGE_EXTS.has(ext)) continue;

            const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const destPath = path.join(targetDir, safeName);
            const buffer = Buffer.from(await file.arrayBuffer());
            fs.writeFileSync(destPath, buffer);
            saved.push(`/${folder}/${safeName}`);
        }

        return NextResponse.json({ ok: true, saved });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    try {
        const url = new URL(req.url);
        const imgPath = url.searchParams.get('path'); // e.g. /perfect-generations/file.jpg
        const folder = url.searchParams.get('folder');

        if (!imgPath || !folder || !ALLOWED_FOLDERS.has(folder)) {
            return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
        }

        const fileName = path.basename(imgPath);
        const targetDir = path.join(process.cwd(), 'public', folder);
        const absPath = path.join(targetDir, fileName);

        // Security: must be inside the allowed folder
        if (!absPath.startsWith(targetDir)) {
            return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
        }

        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        return NextResponse.json({ ok: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
