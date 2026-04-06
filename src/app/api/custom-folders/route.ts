import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.JPG', '.JPEG', '.PNG', '.WEBP']);

function getImagesInDir(folderName: string): string[] {
    const dirPath = path.join(process.cwd(), 'public', folderName);
    if (!fs.existsSync(dirPath)) return [];
    
    try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        return files
            .filter(f => f.isFile() && IMAGE_EXTS.has(path.extname(f.name)))
            .map(f => `/${folderName}/${f.name}`);
    } catch {
        return [];
    }
}

export async function GET() {
    try {
        const perfectGenerations = getImagesInDir('perfect-generations');
        const needsFixing = getImagesInDir('needs-fixing');
        
        return NextResponse.json({ perfectGenerations, needsFixing });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
