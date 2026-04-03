import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), '.feedback');
const LOG_FILE = path.join(LOG_DIR, 'log.jsonl');

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const entry = {
            ts: new Date().toISOString(),
            jobId: body.jobId,
            modelId: body.modelId,
            prompt: body.prompt,
            formatLabel: body.formatLabel,
            issues: body.issues,      // string[]
            note: body.note || '',    // free-text
            rating: body.rating,      // 'good' | 'bad'
        };
        if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });
        await writeFile(LOG_FILE, JSON.stringify(entry) + '\n', { flag: 'a' });
        return NextResponse.json({ ok: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
