'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, CornerDownLeft, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { assistant, SUGGESTED_QUESTIONS, type AssistantAnswer } from '@/lib/assistant/engine';
import { Button } from '@/components/ui/primitives';

/**
 * Operator assistant panel.
 *
 * The "no language model" property is stated in the UI rather than hidden,
 * because it is a feature here: every answer is assembled from the same state
 * the screens render, so it cannot drift from what the operator is looking at.
 */
export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const world = useResolvedWorld();
  const settings = useSkyGuard((s) => s.settings);
  const selectedStationId = useSkyGuard((s) => s.selectedStationId);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const ask = async (q: string) => {
    if (!world || !q.trim()) return;
    setBusy(true);
    setQuestion(q);
    try {
      const result = await assistant.ask(q, { world, settings, selectedStationId });
      setAnswer(result);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-bg/60"
      role="dialog"
      aria-modal="true"
      aria-label="Operator assistant"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-[440px] flex-col border-l border-line bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3">
          <Bot size={16} className="text-healthy" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Operator assistant</div>
            <div className="truncate text-[10px] text-ink-3">
              Deterministic intents over live application state — no external model
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={14} aria-hidden />
            <span className="sr-only">Close assistant</span>
          </Button>
        </header>

        <form
          className="shrink-0 border-b border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <div className="flex items-center gap-2 rounded-[3px] border border-line bg-raised px-2.5 py-1.5 focus-within:border-line-strong">
            <input
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about a station, anomaly or incident…"
              aria-label="Ask the operator assistant"
              className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-3 focus:outline-none"
            />
            {busy ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-ink-3" aria-hidden />
            ) : (
              <CornerDownLeft size={12} className="shrink-0 text-ink-3" aria-hidden />
            )}
          </div>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!answer && (
            <div>
              <div className="eyebrow mb-2">Try asking</div>
              <div className="flex flex-col gap-1.5">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void ask(q)}
                    className="rounded-[3px] border border-line bg-raised px-2.5 py-1.5 text-left text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {answer && (
            <article className="flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] leading-snug font-semibold text-ink">
                    {answer.headline}
                  </h3>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded-[2px] px-1 py-px text-[9px] font-semibold tracking-wider uppercase',
                      answer.match === 'exact' && 'bg-healthy/12 text-healthy',
                      answer.match === 'partial' && 'bg-warning/12 text-warning',
                      answer.match === 'none' && 'bg-line text-ink-3',
                    )}
                  >
                    {answer.match} match
                  </span>
                  <span className="text-[9.5px] text-ink-3">intent: {answer.intent}</span>
                </div>
              </div>

              {answer.paragraphs.map((p, i) => (
                <p key={i} className="text-[12px] leading-relaxed whitespace-pre-line text-ink-2">
                  {p}
                </p>
              ))}

              {answer.facts.length > 0 && (
                <dl className="panel divide-y divide-line">
                  {answer.facts.map((f) => (
                    <div key={f.label} className="flex items-start gap-3 px-2.5 py-1.5">
                      <dt className="w-[38%] shrink-0 text-[11px] text-ink-3">{f.label}</dt>
                      <dd className="min-w-0 flex-1 text-[11.5px] text-ink">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {answer.links.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {answer.links.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      onClick={onClose}
                      className="rounded-[3px] border border-event/40 bg-event/10 px-2 py-1 text-[11px] text-event transition-colors hover:bg-event/18"
                    >
                      {l.label}
                    </Link>
                  ))}
                </div>
              )}
            </article>
          )}
        </div>
      </aside>
    </div>
  );
}
