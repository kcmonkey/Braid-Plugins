import React, { useEffect, useState } from 'react';
import type { BoardElementPlugin, BoardMenuItem, BoardPluginApi, ContextProviderPlugin, PluginManifest, RunPolicyPlugin, SeedArtifact } from '../../../src/plugin-api/types';
import { boardTurns, hasPendingAsk, latestAnswer, type BoardLike as BoardData } from '../shared/board';
import { runStep, runArm, runDoneVisible, sig, MAX_CONTINUES, RUN_DONE_SENTINEL, type RunState } from './runStep';
import { detectCreatedPlan, latestCreatedPlan, planWriteSignal } from './detect';
import { planContextText } from './methodology';
import { firstHeading, parseGates, parsePlanSnapshot, type PlanSnapshot } from './parse';
// The FULL authoring methodology, shipped IN this plugin (esbuild `.md` text loader inlines it). This is the
// SSOT; `seedArtifacts` drops a copy at `.braid/plans/_authoring.md` so the agent can Read it on demand. (方向O)
import PLAN_AUTHORING from './plan-authoring.md';
import manifestJson from './plugin.json';

// Where the plugin seeds its authoring doc, and the exact bytes it writes (a managed-file header + the doc).
// The compact methodology (methodology.ts) points the agent here; the agent reads it lazily.
const AUTHORING_DOC_PATH = '.braid/plans/_authoring.md';
const AUTHORING_DOC = `<!-- Managed by the Braid Plan plugin — edits are overwritten on plugin update. -->\n\n${PLAN_AUTHORING}`;

// Plan board element. A board binds to a `.braid/plans/<planId>` folder; the binding lives in this plugin's
// PER-BOARD state (`board.elements.plan`), persisted via serialize (`...data`, D7) with NO GRAPH_VERSION bump.
//
// NO buttons (the user's ask): you drive the plan by TALKING to the agent, not by clicking. A context provider
// (P1 seam) tells the agent — on every turn of a bound board — to read the authoritative plan files, and to emit
// a BRAID_RUN_BEGIN marker when you ask it to EXECUTE the plan (vs just discuss). That marker arms the always-on
// run loop (Gap E, `planRunPolicy`); the agent emits BRAID_RUN_DONE only when the USER'S requested scope is done
// (current phase if they asked for that, or every roadmap phase if they asked for the full plan). So "run the plan"
// / "一口气跑完" starts an autonomous run with no UI control. The plugin's job is READ + VISUALIZE:
//   - the board card chip shows `◆ planId · phase · done/total` (quick progress at a glance);
//   - the ChatView panel shows phase + a progress bar + locked decisions + remaining gates + gaps.
// Decisions are recorded by the AGENT editing decisions.md directly (told via the context provider), then shown
// here — no lock button. The generic core seams (oneShot/writeArtifact) remain for other plugins; this plugin
// no longer needs them.

// `open` = the user explicitly asked (via the right-click menu) to bind/change a plan on this board → the
// detail card reveals the picker. NOT shown by default. Cleared on commit/cancel.
interface PlanState { planId: string; run?: RunState; open?: boolean }
// The plan FORMAT (how to author/structure a Braid plan) is a FIXED constant in methodology.ts — identical to
// the Contractors_Showdown contract format, injected on every board. There is no per-plugin config. (D11)
type PlanConfig = Record<string, never>;
export const manifest = manifestJson as PluginManifest;

function asPlanState(s: unknown): PlanState | undefined {
  return s && typeof s === 'object' && typeof (s as PlanState).planId === 'string' ? (s as PlanState) : undefined;
}
// The plugin only ever reads under `.braid/plans/<id>/`; strip anything that could escape that folder.
function safePlanId(id: string): string {
  return id.trim().replace(/[^a-zA-Z0-9._-]/g, '');
}
function planIdOf(board: BoardData): string {
  return safePlanId(asPlanState(board.elements?.plan)?.planId ?? '');
}
function runOf(state: PlanState | undefined): RunState | undefined {
  const r = (state as { run?: RunState } | undefined)?.run;
  return r && (r.status === 'running' || r.status === 'paused') && typeof r.continues === 'number' ? r : undefined;
}
function withoutRun(planId: string, state: PlanState | undefined): PlanState {
  return { planId, ...(state?.open ? { open: true } : {}) };
}

// The auto-continue prompt the run loop re-drives with (the loop lives in `planRunPolicy`, driven at the canvas
// level so a run advances regardless of whether the card is rendered).
const CONTINUE_PROMPT =
  "Continue the Braid plan execution scope the user requested — do NOT stop to ask for confirmation, and do NOT " +
  "just summarize and wait. Always read current-phase.md and contract.md first. If the user asked to complete " +
  "only the current phase, finish every acceptance gate in current-phase.md, run the phase/global verification " +
  "the plan requires, then reply with a concise completion summary covering what changed, which acceptance " +
  `gates / verification passed, and any remaining gaps. Put exactly ${RUN_DONE_SENTINEL} on the last line, with ` +
  "no text after it. If the " +
  "user asked to complete the full/entire/whole plan or all phases, then after each phase passes: update " +
  "evidence/history as needed, promote the next Phase Roadmap item into current-phase.md, and keep working. For " +
  `a full-plan run, emit ${RUN_DONE_SENTINEL} only after the roadmap has no remaining phases and global ` +
  "verification passes, again after a concise completion summary and as the final line. If you genuinely need a human decision, or hit an error you cannot recover from, explain " +
  "briefly and stop.";

// Refetch plan files when the board settles, and while live only when this board writes the bound plan files. That
// keeps normal token streaming from causing read storms while still reflecting an agent that advances current-phase
// during a long autonomous run.
function planVersion(board: BoardData, planId: string): string {
  // Key on turn count + answer length so each settled turn re-fetches even if two answers share a length.
  const writeSig = planWriteSignal(board, planId);
  return board.status === 'done' ? `d${boardTurns(board).length}:${(board.answer ?? '').length}:${writeSig}` : `live:${writeSig}`;
}

// Clamp prose for the panel (goal / phase intent) on a word boundary so a long section can't dominate.
function clampText(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t;
}

// Reads current-phase.md (legacy fallbacks), returns the raw text. Used by the compact chip.
function usePhaseDoc(planId: string, api: BoardPluginApi, version: string) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setErr(null);
    if (!planId) { setMd(null); return; }
    (async () => {
      for (const f of ['current-phase.md', '_summary.md', 'contract.md']) {
        const r = await api.readArtifact(`.braid/plans/${planId}/${f}`);
        if (!alive) return;
        if (r.text) { setMd(r.text); return; }
      }
      if (alive) { setMd(null); setErr('no current-phase.md'); }
    })();
    return () => { alive = false; };
  }, [planId, api, version]);
  return { md, err };
}

// Reads the three plan files and parses the full snapshot. Used by the richer ChatView panel (one panel at a
// time, so 3 reads per settle is cheap).
function usePlanSnapshot(planId: string, api: BoardPluginApi, version: string) {
  const [snap, setSnap] = useState<PlanSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setErr(null);
    if (!planId) { setSnap(null); return; }
    (async () => {
      const read = async (f: string) => (await api.readArtifact(`.braid/plans/${planId}/${f}`)).text ?? '';
      let phaseMd = await read('current-phase.md');
      if (!phaseMd) phaseMd = await read('_summary.md');
      const [decisionsMd, contractMd] = await Promise.all([read('decisions.md'), read('contract.md')]);
      if (!alive) return;
      if (!phaseMd && !decisionsMd && !contractMd) { setSnap(null); setErr('plan files not found'); return; }
      if (!phaseMd) phaseMd = contractMd; // last resort so at least the phase heading shows
      setSnap(parsePlanSnapshot({ phaseMd, decisionsMd, contractMd }));
    })();
    return () => { alive = false; };
  }, [planId, api, version]);
  return { snap, err };
}

// Compact card chip: `◆ planId  [▶ n/6 | ⏸]  done/total  · phase`. Read-only; one file read per settled turn.
function PlanChip({ planId, api, board, run, inline = false }: { planId: string; api: BoardPluginApi; board: BoardData; run?: RunState; inline?: boolean }) {
  const { md, err } = usePhaseDoc(planId, api, planVersion(board, planId));
  const phase = md ? firstHeading(md) : undefined;
  const gates = md ? parseGates(md) : [];
  const done = gates.filter((g) => g.done).length;
  const title = [run?.note, err, phase ? `Phase: ${phase}` : '', gates.length ? `This phase: ${done}/${gates.length} acceptance criteria met` : ''].filter(Boolean).join('\n') || undefined;
  return (
    <div className="board__tags" style={{ display: 'flex', alignItems: 'center', gap: inline ? 5 : 6, flexWrap: inline ? 'nowrap' : undefined, minWidth: inline ? 0 : undefined }} title={title}>
      <span style={{ color: '#83a1ff', fontWeight: 700, fontSize: inline ? 15 : undefined, minWidth: inline ? 0 : undefined, maxWidth: inline ? 130 : undefined, overflow: inline ? 'hidden' : undefined, textOverflow: inline ? 'ellipsis' : undefined, whiteSpace: 'nowrap' }}>◆ {planId}</span>
      {run ? (
        <span style={{ fontSize: inline ? 12 : 10, fontWeight: 700, color: run.status === 'running' ? '#8fc7a6' : '#8c857b', whiteSpace: 'nowrap' }}>
          {run.status === 'running' ? `▶ ${run.continues}/${MAX_CONTINUES}` : '⏸'}
        </span>
      ) : null}
      {gates.length ? (
        <span title={`This phase: ${done}/${gates.length} acceptance criteria met`} style={{ fontSize: inline ? 12 : 10, fontWeight: 700, color: done >= gates.length ? '#8fc7a6' : '#c9a86a', whiteSpace: 'nowrap' }}>
          ✓{done}/{gates.length}
        </span>
      ) : null}
      <span style={{ color: phase ? '#a8a199' : '#8c857b', fontSize: inline ? 12 : 11, minWidth: 0, maxWidth: inline ? 96 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        · {phase ?? (err ?? '…')}
      </span>
    </div>
  );
}

// ChatView panel: an at-a-glance plan status above the conversation — phase, progress bar, locked decisions,
// remaining gates, and declared gaps. Always shows the compact header; a ▾ toggle reveals the detail.
function PlanPanel({ planId, api, board }: { planId: string; api: BoardPluginApi; board: BoardData }) {
  const { snap, err } = usePlanSnapshot(planId, api, planVersion(board, planId));
  // Default COLLAPSED so the panel doesn't eat the conversation area; the always-visible header carries the
  // concise status (plan · phase · progress · run) and the user expands on demand for the full details.
  const [open, setOpen] = useState(false);
  const run = runOf(asPlanState(board.elements?.plan));
  const total = snap?.total ?? 0;
  const done = snap?.done ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const remaining = (snap?.gates ?? []).filter((g) => !g.done);
  const phases = snap?.phases ?? [];
  const phaseIndex = snap?.phaseIndex ?? 0;
  // PLAN-level progress (how many phases) — distinct from the gate fraction (this phase's acceptance criteria).
  const phaseProg = phases.length ? (phaseIndex ? `Phase ${phaseIndex}/${phases.length}` : `${phases.length} phases`) : '';
  const sectionHead = { color: '#8c857b', fontWeight: 700, marginBottom: 3 } as const;

  return (
    <div className="plan-panel nodrag nopan" style={{ flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid #2a2724', background: '#1d1c1a', fontSize: 12 }}>
      {/* Header = the always-visible concise status; clicking anywhere on it expands/collapses the details. The
          right-side "details / hide" affordance + the row hover (CSS) make it discoverable that there's more. */}
      <div
        className="plan-panel__head"
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse plan details' : 'Expand plan details'}
      >
        <span style={{ color: '#83a1ff', fontWeight: 700 }}>◆ {planId}</span>
        <span style={{ color: '#a8a199', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {snap?.phase ?? (err ?? '…')}
        </span>
        {phaseProg ? (
          <span title="Plan phases — from the contract Phase Roadmap (not the gate count)" style={{ fontSize: 11, fontWeight: 700, color: '#8c857b', flexShrink: 0 }}>
            {phaseProg}
          </span>
        ) : null}
        {run ? (
          <span style={{ fontSize: 11, fontWeight: 700, color: run.status === 'running' ? '#8fc7a6' : '#c9a86a' }}>
            {run.status === 'running' ? `▶ running ${run.continues}/${MAX_CONTINUES}` : `⏸ ${run.note ?? 'paused'}`}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {total ? <span title={`Current phase: ${done}/${total} acceptance criteria met`} style={{ color: done >= total ? '#8fc7a6' : '#c9a86a', fontWeight: 700 }}>✓{done}/{total}</span> : null}
        <span className="plan-panel__toggle">{open ? '▾ hide' : '▸ details'}</span>
      </div>
      {total ? (
        <>
          <div style={{ marginTop: 6, height: 5, borderRadius: 3, background: '#2a2724', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: done >= total ? '#8fc7a6' : '#83a1ff' }} />
          </div>
          <div style={{ marginTop: 3, fontSize: 10, color: '#6f6a62' }}>current phase · {done}/{total} acceptance criteria met</div>
        </>
      ) : null}
      {open && snap ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '38vh', overflow: 'auto' }}>
          {/* "What now" first, then what's left, then the locked context, what's excluded, and the overall why. */}
          {snap.phaseGoal ? (
            <div>
              <div style={sectionHead}>This phase</div>
              <div style={{ color: '#bdb6ac', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{clampText(snap.phaseGoal, 400)}</div>
            </div>
          ) : null}
          {snap.phases.length ? (
            <div>
              <div style={sectionHead}>Roadmap · {snap.phases.length} phases</div>
              {snap.phases.map((p, i) => {
                const cur = i + 1 === snap.phaseIndex;
                return (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 2, lineHeight: 1.4, color: cur ? '#bdb6ac' : '#9a948b' }}>
                    <span style={{ color: cur ? '#83a1ff' : '#6f6a62', flexShrink: 0, fontWeight: 700 }}>{cur ? '▸' : `${i + 1}.`}</span>
                    <span style={{ minWidth: 0, wordBreak: 'break-word', fontWeight: cur ? 600 : 400 }}>{clampText(p.replace(/^phase\s+\d+\s*[:—–-]\s*/i, ''), 160)}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {remaining.length ? (
            <div>
              <div style={sectionHead}>Remaining · {remaining.length}</div>
              {remaining.slice(0, 10).map((g, i) => (
                <div key={i} style={{ color: '#bdb6ac', display: 'flex', gap: 6, marginBottom: 2, lineHeight: 1.4 }}>
                  <span style={{ color: '#6f6a62', flexShrink: 0 }}>▢</span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{g.text}</span>
                </div>
              ))}
              {remaining.length > 10 ? <div style={{ color: '#6f6a62' }}>+{remaining.length - 10} more</div> : null}
            </div>
          ) : total ? (
            <div style={{ color: '#8fc7a6' }}>All gates met ✓</div>
          ) : null}
          {snap.decisions.length ? (
            <div>
              <div style={sectionHead}>Decisions · {snap.decisions.length}</div>
              {snap.decisions.map((d) => (
                <div key={d.id} style={{ display: 'flex', gap: 8, marginBottom: 3, lineHeight: 1.4 }}>
                  <b style={{ color: '#a9c0ff', flexShrink: 0 }}>{d.id}</b>
                  {d.title !== d.id ? <span style={{ color: '#cdbf9b', minWidth: 0, wordBreak: 'break-word' }}>{d.title}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          {snap.deferred.length ? (
            <div>
              <div style={sectionHead}>Gaps / out of scope</div>
              {snap.deferred.slice(0, 6).map((g, i) => (
                <div key={i} style={{ color: '#9a948b', marginBottom: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>· {g}</div>
              ))}
              {snap.deferred.length > 6 ? <div style={{ color: '#6f6a62' }}>+{snap.deferred.length - 6} more</div> : null}
            </div>
          ) : null}
          {snap.goal ? (
            <div>
              <div style={sectionHead}>Goal</div>
              <div style={{ color: '#9a948b', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{clampText(snap.goal, 280)}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The plan picker. Shown ONLY when the user opened it from the right-click menu (`open`), never by default.
function PlanBind({ boardId, board, planId, api }: { boardId: string; board: BoardData; planId: string; api: BoardPluginApi }) {
  const [plans, setPlans] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.listArtifacts('.braid/plans').then((r) => {
      if (!alive) return;
      setPlans((r.entries ?? [])
        .filter((e) => e.isDir && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b)));
    });
    return () => { alive = false; };
  }, [api]);
  const commit = (value: string) => {
    const id = safePlanId(value);
    if (!id) return;
    const prev = asPlanState(board.elements?.plan);
    api.patchBoard(boardId, { elements: { ...(board.elements ?? {}), plan: { planId: id, ...(prev?.run ? { run: prev.run } : {}) } } });
  };
  const close = () => {
    const prev = asPlanState(board.elements?.plan);
    api.patchBoard(boardId, { elements: { ...(board.elements ?? {}), plan: { planId: prev?.planId ?? '', ...(prev?.run ? { run: prev.run } : {}) } } });
  };
  return (
    <div className="plugin-config plugin-config--plan" style={{ padding: '6px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#a8a199' }}>
        <span>{planId ? 'Change plan' : 'Bind to plan'} — .braid/plans/&lt;name&gt;</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="nodrag nopan" style={{ flex: 1 }} value={planId} onChange={(e) => commit(e.target.value)}>
            <option value="">{plans == null ? 'Loading…' : plans.length ? '— pick a plan —' : 'No plans in .braid/plans'}</option>
            {(plans ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            {planId && plans && !plans.includes(planId) ? <option value={planId}>{planId} (not in .braid/plans)</option> : null}
          </select>
          <button className="ghost-btn nodrag nopan" type="button" onClick={close} title="Close without changing the binding">✕</button>
        </div>
      </label>
    </div>
  );
}

export const planElementPlugin: BoardElementPlugin<PlanConfig> = {
  id: 'plan',
  label: 'Plan',
  manifest,
  defaultConfig: {},
  render({ slot, boardId, board, api }) {
    const planId = planIdOf(board);
    const open = !!asPlanState(board.elements?.plan)?.open;
    // ChatView: a glanceable plan panel above the conversation (phase / progress / decisions / gaps).
    if (slot === 'chatview-aside') return planId ? <PlanPanel planId={planId} api={api} board={board} /> : null;
    if (slot === 'card-detail') {
      // The detail card ONLY hosts the (rarely used) plan picker, revealed from the right-click menu. The chip is
      // rendered by 'card-top' (visible at detail AND far), so it is NOT repeated here. No run/decision buttons —
      // the plan is driven by talking to the agent.
      return open ? <PlanBind boardId={boardId} board={board} planId={planId} api={api} /> : null;
    }
    if (slot === 'card-head-inline') return planId ? <PlanChip planId={planId} api={api} board={board} run={runOf(asPlanState(board.elements?.plan))} inline /> : null;
    return planId ? <PlanChip planId={planId} api={api} board={board} run={runOf(asPlanState(board.elements?.plan))} /> : null; // compact (card-top)
  },
  // Manual bind lives in the right-click menu, so it's a deliberate action instead of a control on every card.
  boardMenu({ boardId, board, api }) {
    const planId = planIdOf(board);
    const elements = board.elements ?? {};
    const prev = asPlanState(board.elements?.plan);
    const openBinder = () => api.patchBoard(boardId, {
      elements: { ...elements, plan: { planId: prev?.planId ?? '', ...(prev?.run ? { run: prev.run } : {}), open: true } },
    });
    const items: BoardMenuItem[] = [{
      key: 'plan-bind',
      label: planId ? `◆ Change plan (${planId})…` : '◆ Bind to a plan…',
      onClick: openBinder,
    }];
    if (planId) {
      items.push({
        key: 'plan-unbind',
        label: '◆ Unbind plan',
        title: "Remove this board's plan binding",
        onClick: () => { const { plan: _drop, ...rest } = elements; api.patchBoard(boardId, { elements: rest }); },
      });
    }
    return items;
  },
  // A forked child inherits the parent's plan binding (id only — run/open state is NOT carried).
  inheritOnFork(parentState) {
    const ps = asPlanState(parentState);
    return ps?.planId ? { planId: ps.planId } : undefined;
  },
  searchText(state) {
    const planId = asPlanState(state)?.planId;
    return planId ? `plan ${planId}` : undefined;
  },
};

export const planContextProvider: ContextProviderPlugin<PlanConfig> = {
  id: 'plan',
  label: 'Plan',
  manifest,
  defaultConfig: {},
  // Always injects (even on UNBOUND boards): the COMPACT plan format + a pointer to the seeded full doc (so
  // "create a plan" works from natural language anywhere), plus the bound-board run/decision protocol when bound.
  // DORMANT — the agent ignores it unless the user is actually talking about a plan.
  provide({ board }) {
    return { text: planContextText(planIdOf(board)) };
  },
  // 方向O: ship the FULL authoring methodology WITH the plugin and seed it to `.braid/plans/_authoring.md`, so the
  // plugin is self-contained on ANY project and the agent reads the depth ON DEMAND (not injected every turn).
  seedArtifacts(): SeedArtifact[] {
    return [{ path: AUTHORING_DOC_PATH, text: AUTHORING_DOC }];
  },
};

// The run loop, owned at the canvas level (Gap E). NL-armed: when the agent (told by the context provider) emits
// BRAID_RUN_BEGIN, `runArm` adopts a running state; thereafter the tested `runStep` decides continue/pause/wait
// and the driver re-drives with CONTINUE_PROMPT (forcing per-turn bypass so approval prompts don't block the
// run). A manual Stop (core ■) arrives as `interrupted` and disarms the run. All domain logic + the hard cap live
// here; core just applies what this returns.
export const planRunPolicy: RunPolicyPlugin<PlanConfig> = {
  id: 'plan',
  label: 'Plan',
  manifest,
  defaultConfig: {},
  // Also consulted for UNBOUND boards so a board that just created a plan can auto-bind.
  observeUnbound: true,
  // A board is "running plan X" (for the sequential-overlap warning) only while its run is ACTIVELY `running`.
  // A paused/absent run is not an overlap — so a board and its own continuation only warn when BOTH are live.
  runGroupKey(state) {
    const ps = asPlanState(state);
    const planId = safePlanId(ps?.planId ?? '');
    return planId && runOf(ps)?.status === 'running' ? planId : undefined;
  },
  step({ board, state, interrupted }) {
    const planState = asPlanState(state);
    const planId = safePlanId(planState?.planId ?? '');
    if (!planId) {
      // Agent-creates-plan: a SETTLED unbound board whose tool steps created exactly one plan auto-binds to it.
      if (board.status === 'done') {
        const created = detectCreatedPlan(board);
        if (created) return { state: { planId: created } };
      }
      return null;
    }
    const run = runOf(planState);
    // RE-BIND: a board already bound to plan A that GENERATES a new plan B (writes B/contract.md) should follow B —
    // the binding tracks the plan the board is actually authoring. Only when SETTLED and NOT mid-run, so an
    // in-progress execution of A isn't hijacked; switching drops A's run/open state (a fresh plan starts clean). The
    // detector keys on the most-recent contract.md write, so editing/referencing another plan does NOT switch.
    if (!run && board.status === 'done') {
      const created = latestCreatedPlan(board);
      if (created && created !== planId) return { state: { planId: created } };
    }
    // `seenTurns` is stamped on every action so arming can EDGE-trigger on a newer turn (see runArm). turnCount
    // grows by one per turn (the arming turn, then each auto-continue), so a stopped/completed turn is "seen".
    const turnCount = boardTurns(board).length;
    const la = latestAnswer(board);
    // A board with FEWER turns than when the run last acted was truncated in place by a ChatView fork/split
    // (splitBoardAtTurn / splitBoardIntoTurnBoards rewrite a board's turns[]). Its answer no longer matches the
    // run's lastSig, so the auto-continue loop would re-drive it as a phantom "Generating…" turn. A manual
    // fork/split is the user taking over → pause once. seenTurns stays above the new turn count, so a stale BEGIN
    // marker now sitting in the top turn can't re-arm it, and the next tick reads `paused` → wait (no churn loop).
    if (run?.status === 'running' && turnCount < (run.seenTurns ?? 0)) {
      return { state: { planId, run: { ...run, status: 'paused' } } };
    }
    const liveCompletion = (board.status === 'streaming' || board.status === 'waiting') && runDoneVisible(la);
    if (liveCompletion) {
      const answerSig = sig(la);
      if (!(run?.status === 'paused' && run.lastSig === answerSig && run.note === 'completed ✓')) {
        return {
          state: { planId, run: { status: 'paused', continues: run?.continues ?? 0, lastSig: answerSig, seenTurns: turnCount, note: 'completed ✓' } },
          stop: true,
        };
      }
    }
    // Manual Stop (core ■) disarms an active run — otherwise the loop would auto-continue right past the stop.
    // Stamp seenTurns so the just-stopped turn's lingering BEGIN marker can't immediately re-arm (review fix).
    if (interrupted && run?.status === 'running') {
      return { state: { planId, run: { ...run, status: 'paused', seenTurns: turnCount, note: 'paused — you stopped it' } } };
    }
    // An interrupted board with NO active run but a (possibly stale) BEGIN marker that runArm WOULD fire on must
    // not auto-(re)start. This is the ChatView fork/split case: truncating a board in place can surface an old
    // arming turn as the new latest answer, which would otherwise re-arm the run as a phantom "Generating…" turn
    // (the fork marks the source board interrupted). Stamp it seen so the stale marker can't arm; a genuinely new
    // run request on a LATER turn still arms (turnCount climbs past seenTurns).
    if (interrupted && !run && runArm(run, la, turnCount)) {
      return { state: { planId, run: { status: 'paused', continues: 0, seenTurns: turnCount } } };
    }
    // ARM by natural language: the agent emits a BRAID_RUN_BEGIN line when YOU ask it to execute the plan. No
    // keyword matching — the agent classifies intent. `runArm` edge-triggers on turnCount > seenTurns so a stale
    // marker (after a Stop / completion) can't restart the run; only a genuinely new request does.
    const armed = runArm(run, la, turnCount);
    if (armed) return { state: { planId, run: armed } };
    // A paused run note describes the turn it stopped/completed on. Once a newer turn has moved on without
    // re-arming, the old "you stopped it" / cap / needs-answer label is stale UI state; drop it instead of
    // continuing to pin the plan header to an old interruption.
    if (run?.status === 'paused' && turnCount > (run.seenTurns ?? 0)) return { state: withoutRun(planId, planState) };
    // CONTINUE / PAUSE / WAIT. A pending AskUserQuestion is a real human decision → pause. A permission prompt is
    // NOT a pause (continues bypass approvals; turn 1 just waits for your approval, then the run resumes).
    const d = runStep(run, board.status, la, hasPendingAsk(board));
    if (d.action === 'wait') return null;
    const next: RunState = { ...d.next, seenTurns: turnCount };
    return d.action === 'continue'
      ? { drive: CONTINUE_PROMPT, state: { planId, run: next }, permissionMode: 'bypassPermissions' }
      : { state: { planId, run: next }, ...(d.stop ? { stop: true } : {}) };
  },
};
