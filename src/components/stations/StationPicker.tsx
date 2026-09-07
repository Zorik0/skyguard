'use client';

import { useSkyGuard } from '@/store/useSkyGuard';
import { useResolvedWorld } from '@/hooks/useWorld';
import { STATUS_META } from '@/lib/units';

/** Station selector used on every station-scoped screen. */
export function StationPicker({ className }: { className?: string }) {
  const world = useResolvedWorld();
  const selected = useSkyGuard((s) => s.selectedStationId);
  const selectStation = useSkyGuard((s) => s.selectStation);

  return (
    <label className={className}>
      <span className="sr-only">Selected station</span>
      <select
        value={selected}
        onChange={(e) => selectStation(e.target.value)}
        className="rounded-[3px] border border-line bg-raised px-2 py-1 text-[11.5px] text-ink"
      >
        {world?.snapshots.map((s) => (
          <option key={s.station.id} value={s.station.id}>
            {s.station.id} · {s.station.name} · {STATUS_META[s.status].label}
          </option>
        ))}
      </select>
    </label>
  );
}
