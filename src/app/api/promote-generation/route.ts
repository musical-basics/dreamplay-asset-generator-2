import { NextRequest, NextResponse } from 'next/server';
import { assetIndexer } from '@/lib/supabase';

/**
 * POST /api/promote-generation
 * Body: { id: string }
 *
 * Copies an approved merch_generation into asset_indexer.assets
 * so dreamplay-media-indexer-2 can discover it.
 */
export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    // Fetch the merch generation record
    const { data: gen, error: fetchErr } = await assetIndexer()
      .from('merch_generations')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !gen) {
      return NextResponse.json({ error: fetchErr?.message || 'Generation not found' }, { status: 404 });
    }

    if (gen.promoted) {
      return NextResponse.json({ success: true, alreadyPromoted: true });
    }

    const now = Date.now();

    // Insert into asset_indexer.assets following the AssetRecord schema
    const assetRow = {
      id:               gen.id,
      filePath:         gen.file_path,
      fileName:         gen.file_name,
      fileSize:         0,                         // not tracked for AI generations
      mimeType:         'image/png',
      mediaType:        'image',

      // Technical — not applicable for AI-generated images
      width:            null,
      height:           null,
      durationSeconds:  null,
      fps:              null,
      codec:            null,
      orientation:      null,
      aspectRatio:      gen.aspect_ratio || null,

      // Taxonomy — defaults for AI-generated merch
      subject:          'product',
      handZone:         null,
      dsModel:          null,
      purpose:          'marketing',
      campaign:         'Other',
      shotType:         'unknown',
      finalStatus:      'final',
      colorLabel:       null,
      priority:         'normal',
      mood:             '',
      colorGrade:       '',
      aiDescription:    gen.prompt || '',
      aiKeywords:       JSON.stringify([gen.model_name, gen.format_label].filter(Boolean)),

      thumbPath:        null,
      ingestedAt:       gen.created_at || now,
      updatedAt:        now,
    };

    const { error: insertErr } = await assetIndexer()
      .from('assets')
      .upsert(assetRow, { onConflict: 'filePath' });

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    // Mark as promoted in merch_generations
    await assetIndexer()
      .from('merch_generations')
      .update({ promoted: true, updated_at: now })
      .eq('id', id);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[promote-generation]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
