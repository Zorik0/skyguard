'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Radar frame playback.
 *
 * Kept out of the map component so the animation loop survives map re-renders
 * and so the controls can live anywhere on the page.
 */
export function useRadarPlayback(frameCount: number, baseIntervalMs = 620) {
  // `null` means "follow the newest frame". Deriving the default rather than
  // syncing it in an effect means a fresh batch of frames lands on the latest
  // one without a cascading render, and a scrubbing operator is never yanked
  // forward mid-drag.
  const [selected, setSelected] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const last = Math.max(0, frameCount - 1);
  const index = selected === null ? last : Math.min(selected, last);

  useEffect(() => {
    if (!playing || frameCount < 2) return;
    const id = window.setInterval(
      () => setSelected((i) => ((i ?? last) + 1) % frameCount),
      baseIntervalMs / speed,
    );
    return () => window.clearInterval(id);
  }, [playing, frameCount, speed, baseIntervalMs, last]);

  const next = useCallback(
    () => setSelected((i) => (frameCount ? ((i ?? last) + 1) % frameCount : 0)),
    [frameCount, last],
  );
  const prev = useCallback(
    () => setSelected((i) => (frameCount ? ((i ?? last) - 1 + frameCount) % frameCount : 0)),
    [frameCount, last],
  );

  return {
    index,
    setIndex: (value: number) => setSelected(value),
    playing,
    toggle: () => setPlaying((p) => !p),
    speed,
    setSpeed,
    next,
    prev,
  };
}
