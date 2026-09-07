import { z } from 'zod';
import type { RadarMeta } from '@/types';
import { fetchJson, type RadarProvider } from './provider';

/**
 * RainViewer radar.
 *
 * Radar is supporting evidence, never a required input. When the provider is
 * unreachable the layer reports itself unavailable and the map carries on —
 * the one thing it must never do is invent frames.
 */
const RAINVIEWER_META = 'https://api.rainviewer.com/public/weather-maps.json';

const frameSchema = z.object({ time: z.number(), path: z.string() });

const metaSchema = z.object({
  host: z.string(),
  radar: z
    .object({
      past: z.array(frameSchema).optional(),
      nowcast: z.array(frameSchema).optional(),
    })
    .optional(),
});

export class RainViewerProvider implements RadarProvider {
  readonly name = 'RainViewer';
  readonly attribution = 'Radar imagery © RainViewer';

  async getRadarMeta(): Promise<RadarMeta> {
    // Radar frames publish every ten minutes.
    const raw = await fetchJson<unknown>(RAINVIEWER_META, 300);
    const parsed = metaSchema.parse(raw);
    const past = parsed.radar?.past ?? [];
    const nowcast = parsed.radar?.nowcast ?? [];
    if (!past.length && !nowcast.length) {
      return { host: parsed.host, past: [], nowcast: [], status: 'unavailable' };
    }
    return {
      host: parsed.host,
      past: past.map((f) => ({ time: f.time * 1000, path: f.path })),
      nowcast: nowcast.map((f) => ({ time: f.time * 1000, path: f.path })),
      status: 'live',
    };
  }
}

export const rainViewer = new RainViewerProvider();

/** Tile URL for one radar frame, in the colour scheme used on the map. */
export function radarTileUrl(host: string, path: string) {
  return `${host}${path}/256/{z}/{x}/{y}/4/1_1.png`;
}
