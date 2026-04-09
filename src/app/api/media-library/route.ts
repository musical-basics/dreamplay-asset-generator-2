import { NextRequest, NextResponse } from 'next/server';
import { assetIndexer } from '@/lib/supabase';

// GET — query asset_indexer.assets (media indexer-2 library)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = parseInt(sp.get('limit') || '200');
    const offset = parseInt(sp.get('offset') || '0');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function applyFilters(q: any): any {
      const addEq = (col: string, param: string) => {
        const v = sp.get(param);
        if (v) q = q.eq(col, v);
        return q;
      };
      q = addEq('finalStatus',  'finalStatus');
      q = addEq('subject',      'subject');
      q = addEq('handZone',     'handZone');
      q = addEq('dsModel',      'dsModel');
      q = addEq('purpose',      'purpose');
      q = addEq('campaign',     'campaign');
      q = addEq('shotType',     'shotType');
      q = addEq('colorLabel',   'colorLabel');
      q = addEq('priority',     'priority');
      q = addEq('mediaType',    'mediaType');
      q = addEq('orientation',  'orientation');

      const search = sp.get('search');
      if (search) {
        const term = `%${search}%`;
        q = q.or(`aiDescription.ilike.${term},aiKeywords.ilike.${term},fileName.ilike.${term}`);
      }
      const minDur = sp.get('minDuration');
      const maxDur = sp.get('maxDuration');
      if (minDur) q = q.gte('durationSeconds', parseFloat(minDur));
      if (maxDur) q = q.lte('durationSeconds', parseFloat(maxDur));
      return q;
    }

    let dataQ = assetIndexer()
      .from('assets')
      .select('*')
      .order('priority',     { ascending: false })
      .order('finalStatus',  { ascending: true })
      .order('updatedAt',    { ascending: false })
      .range(offset, offset + limit - 1);

    let countQ = assetIndexer()
      .from('assets')
      .select('*', { count: 'exact', head: true });

    dataQ  = applyFilters(dataQ);
    countQ = applyFilters(countQ);

    const [
      { data, error: dataErr },
      { count, error: countErr },
      { count: total,   error: e1 },
      { count: finals,  error: e2 },
      { count: highPri, error: e3 },
    ] = await Promise.all([
      dataQ,
      countQ,
      assetIndexer().from('assets').select('*', { count: 'exact', head: true }),
      assetIndexer().from('assets').select('*', { count: 'exact', head: true }).eq('finalStatus', 'final'),
      assetIndexer().from('assets').select('*', { count: 'exact', head: true }).eq('priority', 'high'),
    ]);

    if (dataErr)  throw new Error(dataErr.message);
    if (countErr) throw new Error(countErr.message);
    if (e1 || e2 || e3) throw new Error('Stats query failed');

    return NextResponse.json({
      assets: data ?? [],
      total:  count  ?? 0,
      stats:  { total: total ?? 0, finals: finals ?? 0, highPriority: highPri ?? 0 },
    });
  } catch (err) {
    console.error('[API /media-library] Error:', err);
    return NextResponse.json(
      { error: 'Failed to query media library', assets: [], total: 0, stats: { total: 0, finals: 0, highPriority: 0 } },
      { status: 500 },
    );
  }
}
