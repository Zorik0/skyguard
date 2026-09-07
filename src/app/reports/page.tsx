'use client';

import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { Button, Panel, SourceBadge, StatTile } from '@/components/ui/primitives';
import { downloadReport, REPORTS, toCsv, type ReportFormat } from '@/lib/reports/export';

/**
 * Reports.
 *
 * Every export is generated in the browser from the live world object, so what
 * lands in the file is exactly what the screens were showing — including the
 * separation between raw and corrected values.
 */
export default function ReportsPage() {
  const world = useResolvedWorld();
  const [preview, setPreview] = useState<string>(REPORTS[0].id);

  const rowsById = useMemo(() => {
    if (!world) return new Map<string, Record<string, unknown>[]>();
    return new Map(REPORTS.map((r) => [r.id, r.build(world)] as const));
  }, [world]);

  if (!world) return null;

  const previewReport = REPORTS.find((r) => r.id === preview)!;
  const previewRows = rowsById.get(preview) ?? [];
  const previewCsv = toCsv(previewRows.slice(0, 6));
  const stamp = format(world.now, 'yyyyMMdd-HHmm');
  const totalRows = [...rowsById.values()].reduce((a, r) => a + r.length, 0);

  const handleDownload = (id: string, fmt: ReportFormat) => {
    const rows = rowsById.get(id) ?? [];
    downloadReport(rows, `skyguard-${id}-${stamp}`, fmt);
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Client-side exports built from the same data model the console renders. Nothing is re-queried, so nothing can disagree."
        actions={<SourceBadge source="SIMULATED" />}
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Reports available" value={REPORTS.length} />
          <StatTile label="Rows ready" value={totalRows.toLocaleString()} hint="across all reports" />
          <StatTile label="Generated at" value={format(world.now, 'HH:mm')} hint={format(world.now, 'dd MMM yyyy')} />
          <StatTile label="Raw values preserved" value="100%" tone="healthy" hint="corrections are additional columns" />
        </section>

        <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
          <Panel eyebrow="Catalogue" title="Available reports">
            <ul className="divide-y divide-line">
              {REPORTS.map((r) => {
                const rows = rowsById.get(r.id) ?? [];
                return (
                  <li
                    key={r.id}
                    className={`px-3 py-2.5 transition-colors ${preview === r.id ? 'bg-raised' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => setPreview(r.id)}
                      className="block w-full text-left"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12.5px] font-medium text-ink">{r.name}</span>
                        <span className="tnum text-[10px] text-ink-3">
                          {rows.length.toLocaleString()} rows
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
                        {r.description}
                      </p>
                    </button>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {r.formats.includes('csv') && (
                        <Button size="sm" onClick={() => handleDownload(r.id, 'csv')} disabled={!rows.length}>
                          <FileSpreadsheet size={11} aria-hidden /> CSV
                        </Button>
                      )}
                      {r.formats.includes('json') && (
                        <Button size="sm" onClick={() => handleDownload(r.id, 'json')} disabled={!rows.length}>
                          <FileJson size={11} aria-hidden /> JSON
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <div className="flex flex-col gap-3">
            <Panel
              eyebrow="Preview"
              title={previewReport.name}
              actions={
                <Button size="sm" variant="primary" onClick={() => handleDownload(preview, 'csv')}>
                  <Download size={11} aria-hidden /> Download CSV
                </Button>
              }
            >
              <div className="p-3">
                <p className="mb-2 text-[11px] text-ink-3">
                  First {Math.min(6, previewRows.length)} of{' '}
                  {previewRows.length.toLocaleString()} rows.
                </p>
                <pre className="tnum max-h-[360px] overflow-auto rounded-[3px] border border-line bg-raised p-2.5 text-[10.5px] leading-relaxed whitespace-pre text-ink-2">
                  {previewCsv || 'No rows in this report.'}
                </pre>
              </div>
            </Panel>

            <Panel eyebrow="Notes" title="What is in these files">
              <div className="flex flex-col gap-2 p-3 text-[11.5px] leading-relaxed text-ink-3">
                <p>
                  The raw-data export contains the values the stations actually reported, unmodified,
                  including the readings that were later classified as faults. Nothing is filtered
                  out of it.
                </p>
                <p>
                  The quality-controlled dataset carries the same raw columns plus a flag and, where
                  a correction was published, a separate corrected column. A consumer can always
                  recover the original measurement.
                </p>
                <p>
                  Station telemetry in every export is simulated — public weather APIs cannot report
                  the internal state of this fictional hardware. External model values, where they
                  appear, come from Open-Meteo and are labelled as such.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  );
}
