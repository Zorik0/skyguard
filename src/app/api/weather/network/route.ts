import { NextResponse } from 'next/server';
import { buildStations } from '@/lib/simulation/stations';
import { openMeteo } from '@/lib/weather/openMeteo';
import type { ExternalContext } from '@/types';

/**
 * External weather context for the whole station network in one round trip.
 *
 * This route is the only thing in the application that talks to a weather API.
 * It always answers 200 with a well-formed payload: if the provider fails, the
 * contexts come back marked `error` and the dashboard runs on simulation
 * context instead. An outage upstream must never blank an operations screen.
 */
export const revalidate = 300;

export async function GET() {
  const stations = buildStations(Date.now());
  const points = stations.map((s) => ({ latitude: s.latitude, longitude: s.longitude }));
  const fetchedAt = Date.now();

  try {
    const bundles = await openMeteo.getBundles(points);
    const contexts: ExternalContext[] = stations.map((station, i) => {
      const bundle = bundles[i];
      const ok = Boolean(bundle?.current) || Boolean(bundle?.hourly.length);
      return {
        stationId: station.id,
        provider: openMeteo.name,
        fetchedAt,
        current: bundle?.current ?? null,
        hourly: bundle?.hourly ?? [],
        ensemble: [],
        elevation: bundle?.elevation ?? null,
        status: ok ? 'live' : 'error',
        message: ok ? undefined : 'Provider returned no usable values for this location',
      };
    });
    return NextResponse.json({
      status: 'live',
      provider: openMeteo.name,
      attribution: openMeteo.attribution,
      fetchedAt,
      contexts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown provider error';
    return NextResponse.json({
      status: 'error',
      provider: openMeteo.name,
      attribution: openMeteo.attribution,
      fetchedAt,
      message,
      contexts: stations.map<ExternalContext>((station) => ({
        stationId: station.id,
        provider: openMeteo.name,
        fetchedAt,
        current: null,
        hourly: [],
        ensemble: [],
        elevation: null,
        status: 'error',
        message,
      })),
    });
  }
}
