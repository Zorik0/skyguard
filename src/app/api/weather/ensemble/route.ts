import { NextResponse } from 'next/server';
import { buildStations } from '@/lib/simulation/stations';
import { openMeteo } from '@/lib/weather/openMeteo';

/**
 * Ensemble spread for one station. Requested only for the station an operator
 * is actually looking at — twelve ensemble pulls per page load would be a poor
 * neighbour on a free public API.
 */
export const revalidate = 3600;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const stationId = searchParams.get('station');
  const station = buildStations(Date.now()).find((s) => s.id === stationId);

  if (!station) {
    return NextResponse.json({ status: 'error', message: 'Unknown station', bands: [] }, { status: 400 });
  }

  try {
    const bands = await openMeteo.getEnsembleForecast({
      latitude: station.latitude,
      longitude: station.longitude,
    });
    return NextResponse.json({
      status: bands.length ? 'live' : 'error',
      stationId: station.id,
      bands,
      attribution: openMeteo.attribution,
    });
  } catch (error) {
    return NextResponse.json({
      status: 'error',
      stationId: station.id,
      bands: [],
      message: error instanceof Error ? error.message : 'Ensemble unavailable',
    });
  }
}
