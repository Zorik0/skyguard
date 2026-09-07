'use client';

import { RotateCcw } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { DEFAULT_SETTINGS, useSkyGuard, type Settings } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { Button, Panel, SegmentedControl } from '@/components/ui/primitives';
import { DEFAULT_PHYSICS_CONFIG, scaleConfig } from '@/lib/physics/rules';
import { round } from '@/lib/utils';

/**
 * Settings.
 *
 * The thresholds here feed straight into the physics engine — the sensitivity
 * dial is not cosmetic, it rescales every rule limit and the detection
 * z-threshold, and the effect is previewed below so an operator can see what
 * they are about to change before they change it.
 */
export default function SettingsPage() {
  const world = useResolvedWorld();
  const settings = useSkyGuard((s) => s.settings);
  const update = useSkyGuard((s) => s.updateSettings);
  const seed = useSkyGuard((s) => s.seed);
  const mode = useSkyGuard((s) => s.mode);
  const setMode = useSkyGuard((s) => s.setMode);
  const externalStatus = useSkyGuard((s) => s.externalStatus);

  const preview = scaleConfig(DEFAULT_PHYSICS_CONFIG, settings.sensitivity);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Units, detection thresholds, providers and interface preferences. Stored locally in this browser."
        actions={
          <Button size="sm" onClick={() => update(DEFAULT_SETTINGS)}>
            <RotateCcw size={11} aria-hidden /> Reset to defaults
          </Button>
        }
      />

      <PageBody className="grid gap-3 xl:grid-cols-2">
        <Panel eyebrow="Display" title="Units">
          <div className="flex flex-col divide-y divide-line">
            <Row label="Temperature" hint="Conversion happens at display time; engines always work in SI.">
              <SegmentedControl
                ariaLabel="Temperature unit"
                size="sm"
                value={settings.temperatureUnit}
                onChange={(v) => update({ temperatureUnit: v as Settings['temperatureUnit'] })}
                options={[
                  { value: 'C', label: '°C' },
                  { value: 'F', label: '°F' },
                ]}
              />
            </Row>
            <Row label="Wind speed">
              <SegmentedControl
                ariaLabel="Wind unit"
                size="sm"
                value={settings.windUnit}
                onChange={(v) => update({ windUnit: v as Settings['windUnit'] })}
                options={[
                  { value: 'ms', label: 'm/s' },
                  { value: 'kmh', label: 'km/h' },
                  { value: 'kt', label: 'kt' },
                  { value: 'mph', label: 'mph' },
                ]}
              />
            </Row>
            <Row label="Pressure">
              <SegmentedControl
                ariaLabel="Pressure unit"
                size="sm"
                value={settings.pressureUnit}
                onChange={(v) => update({ pressureUnit: v as Settings['pressureUnit'] })}
                options={[
                  { value: 'hPa', label: 'hPa' },
                  { value: 'inHg', label: 'inHg' },
                ]}
              />
            </Row>
            <Row label="Default station" hint="Selected when the console opens.">
              <select
                value={settings.defaultStationId}
                onChange={(e) => update({ defaultStationId: e.target.value })}
                className={SELECT}
              >
                {world?.stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.id} · {s.name}</option>
                ))}
              </select>
            </Row>
          </div>
        </Panel>

        <Panel eyebrow="Detection" title="Anomaly sensitivity">
          <div className="flex flex-col divide-y divide-line">
            <Row
              label={`Sensitivity — ${settings.sensitivity}`}
              hint="Scales every physics threshold and the statistical detection limit together. Higher values narrow every limit."
            >
              <input
                type="range"
                min={10}
                max={90}
                step={5}
                value={settings.sensitivity}
                onChange={(e) => update({ sensitivity: Number(e.target.value) })}
                className="w-[170px] accent-[var(--color-event)]"
                aria-label="Anomaly sensitivity"
              />
            </Row>

            <div className="px-3 py-2.5">
              <div className="eyebrow mb-1.5">Resulting limits</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <Limit label="Temperature rate" value={`${round(preview.maxTempRateCPerMin, 2)} °C/min`} />
                <Limit label="Pressure rate" value={`${round(preview.maxPressureRateHpaPerMin, 2)} hPa/min`} />
                <Limit label="Humidity rate" value={`${round(preview.maxHumidityRatePctPerMin, 1)} %/min`} />
                <Limit label="Wind rate" value={`${round(preview.maxWindRateMsPerMin, 1)} m/s per min`} />
                <Limit label="Neighbour disagreement" value={`${round(preview.neighbourSigma, 2)} σ`} />
                <Limit label="Twin tolerance (temp)" value={`${round(preview.twinTolerance.temperature ?? 0, 2)} °C`} />
              </dl>
              <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
                Changing this re-runs detection across the whole network immediately. Current
                findings: {world?.anomalies.length ?? 0}.
              </p>
            </div>

            <Row label="Neighbour radius" hint="Maximum distance considered when building the relevance-weighted consensus.">
              <span className="flex items-center gap-2">
                <input
                  type="range"
                  min={40}
                  max={260}
                  step={10}
                  value={settings.neighbourRadiusKm}
                  onChange={(e) => update({ neighbourRadiusKm: Number(e.target.value) })}
                  className="w-[130px] accent-[var(--color-event)]"
                  aria-label="Neighbour radius"
                />
                <span className="tnum w-[54px] text-[11px] text-ink-2">
                  {settings.neighbourRadiusKm} km
                </span>
              </span>
            </Row>

            <Row label="Correction policy" hint="Whether a corrected value is published automatically or held for review.">
              <SegmentedControl
                ariaLabel="Correction policy"
                size="sm"
                value={settings.correctionPolicy}
                onChange={(v) => update({ correctionPolicy: v as Settings['correctionPolicy'] })}
                options={[
                  { value: 'automatic', label: 'Automatic' },
                  { value: 'review', label: 'Hold for review' },
                  { value: 'off', label: 'Flag only' },
                ]}
              />
            </Row>
          </div>
        </Panel>

        <Panel eyebrow="Alerting" title="Severity thresholds">
          <div className="flex flex-col divide-y divide-line">
            {(['warning', 'high', 'critical'] as const).map((key) => (
              <Row key={key} label={`${key[0].toUpperCase()}${key.slice(1)} at score`}>
                <span className="flex items-center gap-2">
                  <input
                    type="range"
                    min={10}
                    max={99}
                    value={settings.alertThresholds[key]}
                    onChange={(e) =>
                      update({
                        alertThresholds: {
                          ...settings.alertThresholds,
                          [key]: Number(e.target.value),
                        },
                      })
                    }
                    className="w-[140px] accent-[var(--color-event)]"
                    aria-label={`${key} threshold`}
                  />
                  <span className="tnum w-6 text-[11px] text-ink-2">
                    {settings.alertThresholds[key]}
                  </span>
                </span>
              </Row>
            ))}
          </div>
        </Panel>

        <Panel eyebrow="Data" title="Providers and mode">
          <div className="flex flex-col divide-y divide-line">
            <Row
              label="Data mode"
              hint="Hybrid uses live external context. Simulation contacts nothing at all."
            >
              <SegmentedControl
                ariaLabel="Data mode"
                size="sm"
                value={mode}
                onChange={(v) => setMode(v as 'hybrid' | 'simulation' | 'demo')}
                options={[
                  { value: 'hybrid', label: 'Hybrid' },
                  { value: 'simulation', label: 'Simulation' },
                  { value: 'demo', label: 'Demo' },
                ]}
              />
            </Row>
            <Row label="External weather provider" hint={`Currently ${externalStatus}.`}>
              <select
                value={settings.provider}
                onChange={(e) => update({ provider: e.target.value as Settings['provider'] })}
                className={SELECT}
              >
                <option value="open-meteo">Open-Meteo (no API key)</option>
              </select>
            </Row>
            <Row label="Radar layer" hint="RainViewer. Disabled automatically if the provider is unreachable.">
              <SegmentedControl
                ariaLabel="Radar"
                size="sm"
                value={settings.radarEnabled ? 'on' : 'off'}
                onChange={(v) => update({ radarEnabled: v === 'on' })}
                options={[
                  { value: 'on', label: 'Enabled' },
                  { value: 'off', label: 'Disabled' },
                ]}
              />
            </Row>
            <Row label="Live updates" hint="Advances the simulation clock every minute.">
              <SegmentedControl
                ariaLabel="Live updates"
                size="sm"
                value={settings.liveUpdates ? 'on' : 'off'}
                onChange={(v) => update({ liveUpdates: v === 'on' })}
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </Row>
            <Row label="Simulation seed" hint="Every value in the network derives from this seed.">
              <span className="tnum text-[11.5px] text-ink-2">{seed}</span>
            </Row>
          </div>
        </Panel>

        <Panel eyebrow="Interface" title="Presentation">
          <div className="flex flex-col divide-y divide-line">
            <Row label="Density" hint="Compact suits a wall display; comfortable suits a laptop.">
              <SegmentedControl
                ariaLabel="Density"
                size="sm"
                value={settings.density}
                onChange={(v) => update({ density: v as Settings['density'] })}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'comfortable', label: 'Comfortable' },
                ]}
              />
            </Row>
            <Row label="Reduced animation" hint="Also honoured automatically when the operating system requests it.">
              <SegmentedControl
                ariaLabel="Reduced animation"
                size="sm"
                value={settings.reducedAnimation ? 'on' : 'off'}
                onChange={(v) => update({ reducedAnimation: v === 'on' })}
                options={[
                  { value: 'off', label: 'Full motion' },
                  { value: 'on', label: 'Reduced' },
                ]}
              />
            </Row>
          </div>
        </Panel>

        <Panel eyebrow="Reference" title="Keyboard shortcuts">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 p-3 text-[11px]">
            {[
              ['⌘K / Ctrl+K', 'Command palette and global search'],
              ['1 – 9, 0', 'Jump to a main section'],
              ['L / A / R / U / S', 'Model lab, alerts, reports, audit, settings'],
              ['M', 'Enter Mission Control'],
              ['Esc', 'Close the palette'],
            ].map(([keys, description]) => (
              <div key={keys} className="flex items-baseline gap-2">
                <dt className="tnum w-[104px] shrink-0 text-ink-2">{keys}</dt>
                <dd className="text-ink-3">{description}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-line px-3 py-2 text-[10.5px] text-ink-3">
            Single-key shortcuts are suppressed while focus is inside a text field.
          </p>
        </Panel>
      </PageBody>
    </>
  );
}

const SELECT = 'rounded-[3px] border border-line bg-raised px-2 py-1 text-[11.5px] text-ink';

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-ink">{label}</div>
        {hint && <p className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tnum text-ink-2">{value}</dd>
    </div>
  );
}
