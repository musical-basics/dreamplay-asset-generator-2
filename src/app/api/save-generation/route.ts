import { NextRequest, NextResponse } from 'next/server';
import { writeFile, readFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { assetIndexer } from '@/lib/supabase';

const GENERATED_DIR = path.join(process.cwd(), 'public', 'generated');

function todayFolder() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// POST — save a generated image + metadata sidecar
export async function POST(req: NextRequest) {
    try {
        const { base64, mimeType, jobId, prompt, enhancedPrompt, modelId, modelName,
            formatLabel, aspectRatio, refImagePaths, brandSuffix, createdAt } = await req.json();

        if (!base64 || !jobId) {
            return NextResponse.json({ error: 'Missing base64 or jobId' }, { status: 400 });
        }

        const dateFolder = todayFolder();
        const outDir = path.join(GENERATED_DIR, dateFolder);
        if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

        const ext = (mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const imgFile = path.join(outDir, `${jobId}.${ext}`);
        const metaFile = path.join(outDir, `${jobId}.json`);

        // Write image
        const imgBuf = Buffer.from(base64, 'base64');
        await writeFile(imgFile, imgBuf);

        // Write metadata sidecar
        const meta = {
            jobId, prompt, enhancedPrompt, modelId, modelName,
            formatLabel, aspectRatio, refImagePaths: refImagePaths || [],
            brandSuffix: brandSuffix || null,
            createdAt: createdAt || Date.now(),
            savedAt: Date.now(),
        };
        await writeFile(metaFile, JSON.stringify(meta, null, 2));

        // Dual-write to Supabase
        const { error: dbErr } = await assetIndexer()
          .from('merch_generations')
          .upsert({
            id:               jobId,
            file_path:        `/generated/${dateFolder}/${jobId}.${ext}`,
            file_name:        `${jobId}.${ext}`,
            prompt:           prompt || null,
            enhanced_prompt:  enhancedPrompt || null,
            model_id:         modelId || null,
            model_name:       modelName || null,
            format_label:     formatLabel || null,
            aspect_ratio:     aspectRatio || null,
            ref_image_paths:  refImagePaths || [],
            brand_suffix:     brandSuffix || null,
            created_at:       createdAt || Date.now(),
            saved_at:         Date.now(),
            updated_at:       Date.now(),
          }, { onConflict: 'id' });
        if (dbErr) console.error('[save-generation] Supabase write failed:', dbErr.message);

        const publicPath = `/generated/${dateFolder}/${jobId}.${ext}`;
        return NextResponse.json({ success: true, path: publicPath });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[save-generation]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// GET — list all saved outputs grouped by date
export async function GET() {
    try {
        if (!existsSync(GENERATED_DIR)) {
            return NextResponse.json({ dates: [] });
        }

        const dateFolders = (await readdir(GENERATED_DIR, { withFileTypes: true }))
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort()
            .reverse(); // newest first

        const dates: Record<string, unknown[]> = {};

        for (const date of dateFolders) {
            const dir = path.join(GENERATED_DIR, date);
            const files = (await readdir(dir)).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

            const items: Record<string, unknown>[] = await Promise.all(files.map(async (f) => {
                const baseName = f.replace(/\.[^.]+$/, '');
                const metaPath = path.join(dir, `${baseName}.json`);
                let meta: Record<string, unknown> = {};
                try { meta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch { /* no meta */ }
                return {
                    path: `/generated/${date}/${f}`,
                    fileName: f,
                    date,
                    ...meta,
                } as Record<string, unknown>;
            }));

            items.sort((a, b) => ((b.createdAt as number) || 0) - ((a.createdAt as number) || 0));
            dates[date] = items;
        }

        return NextResponse.json({ dates });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// DELETE — remove a saved output
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const filePath = searchParams.get('path');
        if (!filePath) return NextResponse.json({ error: 'Missing path' }, { status: 400 });

        const abs = path.join(process.cwd(), 'public', filePath);
        const baseName = abs.replace(/\.[^.]+$/, '');

        const { unlink } = await import('fs/promises');
        await unlink(abs).catch(() => {});
        await unlink(`${baseName}.json`).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// PATCH — update feedback (good/bad) on an existing sidecar
export async function PATCH(req: NextRequest) {
    try {
        const { jobId, date, feedback } = await req.json();
        if (!jobId || !date || !feedback) {
            return NextResponse.json({ error: 'Missing jobId, date, or feedback' }, { status: 400 });
        }
        const dir = path.join(GENERATED_DIR, date);
        // Find the sidecar — jobId is the base name
        const metaFile = path.join(dir, `${jobId}.json`);
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(await readFile(metaFile, 'utf-8')); } catch { /* no sidecar yet */ }
        meta.feedback = feedback;
        await writeFile(metaFile, JSON.stringify(meta, null, 2));

        // Sync feedback to Supabase
        const { error: dbErr } = await assetIndexer()
          .from('merch_generations')
          .update({ feedback, updated_at: Date.now() })
          .eq('id', jobId);
        if (dbErr) console.error('[save-generation PATCH] Supabase update failed:', dbErr.message);

        return NextResponse.json({ success: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
