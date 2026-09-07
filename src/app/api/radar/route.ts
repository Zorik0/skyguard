import { NextResponse } from 'next/server';
import { rainViewer } from '@/lib/weather/rainviewer';

/**
 * Radar frame index. Returns `unavailable` rather than an error status so the
 * map layer can disable itself quietly instead of surfacing a failure the
 * operator cannot act on.
 */
export const revalidate = 300;

export async function GET() {
  try {
    const meta = await rainViewer.getRadarMeta();
    return NextResponse.json({ ...meta, attribution: rainViewer.attribution });
  } catch (error) {
    return NextResponse.json({
      host: '',
      past: [],
      nowcast: [],
      status: 'unavailable',
      attribution: rainViewer.attribution,
      message: error instanceof Error ? error.message : 'Radar provider unavailable',
    });
  }
}
