'use client';

import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowRight, CloudSun, Info, ShieldAlert } from 'lucide-react';
import { useResolvedWorld, useSelectedStation } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { Panel, SourceBadge, StatTile } from '@/components/ui/primitives';
import { StationTable } from '@/components/stations/StationTable';
import { StationMetrics } from '@/components/stations/StationMetrics';
import { StationPicker } from '@/components/stations/StationPicker';
import { AnomalyList } from '@/components/anomalies/AnomalyList';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { DEMO_STORY } from '@/lib/simulation/baseline';
import { NETWORK_NAME } from '@/lib/simulation/stations';

/**
 * The network overview — the landing page, and a good example of how thin
 * every page in this app is.
 *
 * Notice what this component does NOT do: no fetching, no detection, no
 * statistics, no analysis of any kind. It calls `useResolvedWorld()`, gets the
 * finished object, and arranges it on screen. Every page here works this way,
 * which is why they cannot disagree with one another.
 *
 * The `'use client'` at the top of the file marks this as a Client Component:
 * it runs in the browser and may use hooks and event handlers. The pages need
 * it because the whole simulation runs client-side — there is no server and no
 * database.
 */
export default function OverviewPage() {
  const world = useResolvedWorld();
  const snapshot = useSelectedStation();
  const externalStatus = useSkyGuard((s) => s.externalStatus);
  const externalMessage = useSkyGuard((s) => s.externalMessage);
  const mode = useSkyGuard((s) => s.mode);

  // The world is null until the store has hydrated from localStorage on the
  // client. Rendering nothing for that first frame avoids a hydration
  // mismatch — the error React raises when the server's HTML and the client's
  // first render disagree.
  if (!world || !snapshot) return null;

  const m = world.metrics;
  const openIncidents = world.incidents.filter((i) => i.status !== 'resolved');
  const activeAnomalies = world.anomalies
    .filter((a) => a.endedAt === null)
    .sort((a, b) => b.score - a.score);

  const headlineFault = world.anomalies
    .filter((a) => a.stationId === DEMO_STORY.faultStationId && a.classification === 'sensor_fault')
    .sort((a, b) => b.score - a.score)[0];
  // Prefer the anomaly that best *demonstrates* a travelling weather system:
  // the demo story's station first, then whichever belongs to the incident
  // spanning the most stations.
  const metAnomalies = world.anomalies.filter(
    (a) => a.classification === 'meteorological_event',
  );
  const biggestMetIncident = world.incidents
    .filter((i) => i.classification === 'meteorological_event')
    .sort((a, b) => b.stationIds.length - a.stationIds.length)[0];
  const headlineWeather =
    metAnomalies
      .filter((a) => a.stationId === DEMO_STORY.weatherStationId)
      .sort((a, b) => b.score - a.score)[0] ??
    metAnomalies
      .filter((a) => a.incidentId === biggestMetIncident?.id)
      .sort((a, b) => b.score - a.score)[0] ??
    metAnomalies.sort((a, b) => b.score - a.score)[0];

  return (
    <>
      <PageHeader
        title="Network overview"
        subtitle={
          <>
            {NETWORK_NAME} · {world.stations.length} stations ·{' '}
            <span className="tnum">{format(world.now, 'dd MMM yyyy HH:mm')}</span>
          </>
        }
        actions={<StationPicker />}
      />

      <PageBody className="flex flex-col gap-3">
        {/* External context is stated plainly, always — the platform must never
            let a provider outage look like healthy live data. */}
        {externalStatus !== 'live' && (
          <div className="flex items-start gap-2 rounded-[3px] border border-warning/35 bg-warning/8 px-3 py-2">
            <Info size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <p className="text-[11.5px] leading-relaxed text-ink-2">
              <span className="font-medium text-warning">
                {mode === 'simulation'
                  ? 'Simulation mode — external providers are not being contacted.'
                  : 'External weather context unavailable. Using simulation context.'}
              </span>{' '}
              Detection, classification and corrections continue to run on station
              telemetry and neighbour comparison alone.
              {externalMessage && mode !== 'simulation' && (
                <span className="text-ink-3"> ({externalMessage})</span>
              )}
            </p>
          </div>
        )}

        <section aria-label="Network metrics" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label="Stations online"
            value={m.stationsOnline}
            suffix={`/ ${world.stations.length}`}
            tone={m.stationsOffline > 0 ? 'warning' : 'healthy'}
            hint={`${m.stationsOffline} offline`}
            href="/map"
          />
          <StatTile
            label="Stations degraded"
            value={m.stationsDegraded}
            tone={m.stationsDegraded > 0 ? 'warning' : 'healthy'}
            hint="warning, critical or failed"
            href="/health"
          />
          <StatTile
            label="Healthy sensors"
            value={m.healthySensors}
            suffix={`/ ${m.totalSensors}`}
            tone="healthy"
            hint={`${m.sensorsNeedingMaintenance} need attention`}
            href="/health"
          />
          <StatTile
            label="Active anomalies"
            value={m.activeAnomalies}
            tone={m.activeAnomalies > 0 ? 'warning' : 'healthy'}
            hint={`${world.anomalies.length} in the last 24 h`}
            href="/anomalies"
          />
          <StatTile
            label="Critical alerts"
            value={m.criticalAlerts}
            tone={m.criticalAlerts > 0 ? 'failed' : 'healthy'}
            hint="unresolved"
            href="/alerts"
          />
          <StatTile
            label="Weather events"
            value={m.activeWeatherEvents}
            tone="event"
            hint="genuine, no correction applied"
            href="/events"
          />
          <StatTile
            label="Maintenance due"
            value={world.maintenance.filter((t) => t.status !== 'completed').length}
            tone={world.maintenance.some((t) => t.priority === 'critical') ? 'critical' : 'default'}
            hint="open tasks"
            href="/maintenance"
          />
          <StatTile
            label="Incoming rows"
            value={m.rowsPerMinute}
            suffix="/min"
            hint="one packet per station per minute"
          />
          <StatTile
            label="Data quality"
            value={m.dataQualityScore}
            suffix="/100"
            tone={m.dataQualityScore >= 80 ? 'healthy' : m.dataQualityScore >= 60 ? 'warning' : 'critical'}
            hint="mean sensor health across the network"
            href="/health"
          />
          <StatTile
            label="Open incidents"
            value={openIncidents.length}
            tone={openIncidents.some((i) => i.severity === 'critical') ? 'failed' : 'default'}
            hint={`${world.incidents.length} total today`}
            href="/incidents"
          />
        </section>

        {/* The contrast that explains the product, side by side. */}
        <section className="grid gap-3 lg:grid-cols-2">
          {headlineFault && <VerdictCard anomaly={headlineFault} kind="fault" />}
          {headlineWeather && <VerdictCard anomaly={headlineWeather} kind="weather" />}
        </section>

        <Panel
          eyebrow="Network status"
          title="All stations"
          actions={
            <>
              <SourceBadge source="SIMULATED" />
              <Link
                href="/map"
                className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink"
              >
                Map view <ArrowRight size={11} aria-hidden />
              </Link>
            </>
          }
          bodyClassName="overflow-hidden"
        >
          <StationTable world={world} />
        </Panel>

        <div className="grid gap-3 xl:grid-cols-[1.35fr_1fr]">
          <Panel
            eyebrow="Selected station"
            title={`${snapshot.station.id} · ${snapshot.station.name}`}
            actions={
              <Link
                href={`/stations/${snapshot.station.id}`}
                className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink"
              >
                Station profile <ArrowRight size={11} aria-hidden />
              </Link>
            }
          >
            <StationMetrics world={world} snapshot={snapshot} />
          </Panel>

          <Panel
            eyebrow="Live"
            title="Active findings"
            actions={
              <Link
                href="/anomalies"
                className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink"
              >
                All anomalies <ArrowRight size={11} aria-hidden />
              </Link>
            }
            bodyClassName="max-h-[440px] overflow-y-auto"
          >
            <AnomalyList
              anomalies={activeAnomalies}
              limit={12}
              emptyTitle="No active anomalies"
              emptyDetail="Every channel across the network is currently reporting within its expected range."
            />
          </Panel>
        </div>
      </PageBody>
    </>
  );
}

/**
 * The headline verdict card.
 *
 * Deliberately shows the conclusion, the confidence, the evidence and the
 * recommended action together — a score on its own is exactly what this
 * platform is meant not to do.
 */
function VerdictCard({
  anomaly,
  kind,
}: {
  anomaly: NonNullable<ReturnType<typeof useResolvedWorld>>['anomalies'][number];
  kind: 'fault' | 'weather';
}) {
  const accent = kind === 'fault' ? 'var(--color-critical)' : 'var(--color-event)';
  const Icon = kind === 'fault' ? ShieldAlert : CloudSun;

  const supporting = anomaly.evidence
    .filter((e) => e.supports === (kind === 'fault' ? 'fault' : 'weather'))
    .slice(0, 3);

  return (
    <Link
      href={`/anomalies/${anomaly.id}`}
      className="panel group flex flex-col transition-colors hover:border-line-strong"
      style={{ borderColor: `color-mix(in srgb, ${accent} 28%, var(--color-line))` }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{
          borderColor: 'var(--color-line)',
          background: `color-mix(in srgb, ${accent} 7%, transparent)`,
        }}
      >
        <Icon size={14} style={{ color: accent }} aria-hidden />
        <span className="eyebrow" style={{ color: accent }}>
          {kind === 'fault' ? 'Hardware fault detected' : 'Genuine weather confirmed'}
        </span>
        <span className="tnum ml-auto text-[10px] text-ink-3">{anomaly.id}</span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold" style={{ color: accent }}>
              {CLASSIFICATION_LABELS[anomaly.classification]}
            </span>
            <span className="tnum text-[15px] font-semibold" style={{ color: accent }}>
              {anomaly.confidence}%
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] text-ink-2">
            {anomaly.stationId} · {anomaly.title.replace(`${anomaly.stationId} `, '')}
          </p>
        </div>

        {anomaly.correction && anomaly.correction.confidence > 0 ? (
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-[2px] bg-line">
            <div className="bg-raised px-2 py-1.5">
              <dt className="eyebrow">Raw</dt>
              <dd className="tnum mt-0.5 text-[13px] text-ink">
                {anomaly.correction.rawValue}
              </dd>
            </div>
            <div className="bg-raised px-2 py-1.5">
              <dt className="eyebrow" style={{ color: 'var(--color-warning)' }}>
                Corrected
              </dt>
              <dd className="tnum mt-0.5 text-[13px] text-warning">
                {anomaly.correction.correctedValue}
              </dd>
            </div>
            <div className="bg-raised px-2 py-1.5">
              <dt className="eyebrow">Interval</dt>
              <dd className="tnum mt-0.5 text-[11px] text-ink-2">
                {anomaly.correction.interval[0]}–{anomaly.correction.interval[1]}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="rounded-[2px] border border-line bg-raised px-2.5 py-2">
            <div className="eyebrow">Correction</div>
            <p className="mt-0.5 text-[11.5px] text-ink-2">
              None applied — these readings are believed accurate and are published as
              measured.
            </p>
          </div>
        )}

        <ul className="flex flex-col gap-1">
          {supporting.map((e) => (
            <li key={e.id} className="flex items-start gap-1.5 text-[11px] text-ink-2">
              <span
                className="mt-[5px] h-1 w-1 shrink-0 rounded-full"
                style={{ background: accent }}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="font-medium text-ink">{e.label}.</span>{' '}
                <span className="text-ink-3">{e.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-auto border-t border-line pt-2 text-[11px] text-ink-2">
          <span className="eyebrow mr-1.5">Action</span>
          {anomaly.recommendedAction}
        </p>
      </div>
    </Link>
  );
}
