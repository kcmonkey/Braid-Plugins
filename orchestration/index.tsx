import React from 'react';
import type { BoardActionPlugin, BoardElementPlugin, BoardMenuItem, BoardPluginApi, ContextProviderPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { BoardLike as BoardData } from '../shared/board';
import {
  ORCHESTRATION_PLUGIN_ID,
  ORCHESTRATION_ROLES,
  asOrchestrationState,
  decisionRouteLabel,
  initialOrchestrationState,
  newRunId,
  roleDescription,
  roleLabel,
  safePlanId,
  stageLabel,
  upsertRole,
  type OrchestrationRole,
  type OrchestrationStage,
  type OrchestrationState,
  type OrchestrationDecision,
} from './model';
import { captureDecisionFromBoard, captureWorkPackagesFromBoard, captureWorkerReportsFromBoards } from './aggregate';
import {
  buildRunViewModel,
  type BoardMessageLike,
  type BubbleEvent,
  type BubbleKind,
  type BubbleRelation,
  type CardExecutionStatus,
  type ContextBlockLike,
  type ProjectionEdgeLike,
  type RunCardNode,
  type RunViewModel,
  type ScopedIntelEntry,
  type ScopedIntelTier,
} from './viewModel';
import {
  architectPrompt,
  integrationPrompt,
  leadPrompt,
  repairPrompt,
  reviewPrompt,
  roleContextText,
  testPrompt,
  workerPrompt,
} from './prompts';
import manifestJson from './plugin.json';

type OrchestrationConfig = Record<string, never>;

export const manifest = manifestJson as PluginManifest;

function stateOf(board: BoardData): OrchestrationState | undefined {
  return asOrchestrationState(board.elements?.[ORCHESTRATION_PLUGIN_ID]);
}

function patchState(board: BoardData, state: OrchestrationState): Partial<BoardData> {
  return { elements: { ...(board.elements ?? {}), [ORCHESTRATION_PLUGIN_ID]: state } };
}

function setState(api: { patchBoard(boardId: string, patch: Partial<BoardData>): void }, boardId: string, board: BoardData, state: OrchestrationState) {
  api.patchBoard(boardId, patchState(board, state));
}

function RoleChip({ state, inline = false }: { state: OrchestrationState; inline?: boolean }) {
  const label = roleLabel(state.role);
  const title = [
    label,
    roleDescription(state.role),
    `Run: ${state.runId}`,
    `Stage: ${stageLabel(state.stage)}`,
    state.planId ? `Plan: ${state.planId}` : '',
    state.decision ? `Decision: ${decisionRouteLabel(state.decision.route)}` : '',
    state.packageTitle ? `Package: ${state.packageTitle}` : '',
  ].filter(Boolean).join('\n');
  return (
    <div className="board__tags" style={{ display: 'flex', alignItems: 'center', gap: inline ? 5 : 6, flexWrap: inline ? 'nowrap' : undefined, minWidth: 0 }} title={title}>
      <span className="tag" style={{ color: '#8fc7a6', borderColor: '#466854', background: '#1f2d24', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ color: '#a8a199', fontSize: inline ? 11 : 12, minWidth: 0, maxWidth: inline ? 128 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {stageLabel(state.stage)}{state.planId ? ` · ${state.planId}` : ''}
      </span>
    </div>
  );
}

function RolePanel({ state }: { state: OrchestrationState }) {
  const workers = state.workerBoardIds ?? [];
  const packages = state.workPackages ?? [];
  return (
    <div className="plan-panel nodrag nopan" style={{ flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid #2a2724', background: '#1d1c1a', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
        <span style={{ color: '#8fc7a6', fontWeight: 700 }}>{roleLabel(state.role)}</span>
        <span style={{ color: '#a8a199', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stageLabel(state.stage)}</span>
        {state.planId ? <span style={{ color: '#83a1ff', fontWeight: 600 }}>{state.planId}</span> : null}
      </div>
      <div style={{ color: '#8c857b', marginTop: 4 }}>{roleDescription(state.role)}</div>
      {state.decision ? (
        <div style={{ color: '#c9a86a', marginTop: 6 }}>
          Decision: {decisionRouteLabel(state.decision.route)}{state.decision.rationale ? ` · ${state.decision.rationale}` : ''}
        </div>
      ) : null}
      {state.note ? (
        <div style={{ color: '#d38b6d', marginTop: 4 }}>{state.note}</div>
      ) : null}
      {state.packageTitle ? (
        <div style={{ color: '#c9a86a', marginTop: 4 }}>
          {state.packageId}: {state.packageTitle}
        </div>
      ) : null}
      {packages.length ? (
        <div style={{ marginTop: 6, color: '#a8a199' }}>
          Work packages: {packages.length}{workers.length ? ` · workers ${workers.join(', ')}` : ''}
        </div>
      ) : workers.length ? (
        <div style={{ marginTop: 6, color: '#a8a199' }}>Workers: {workers.join(', ')}</div>
      ) : null}
    </div>
  );
}

function OrchestrationRunPanel({ boardId, board, api, state }: { boardId: string; board: BoardData; api: OrchestrationReadApi; state: OrchestrationState }) {
  const readKey = `${state.runId}:${boardId}`;
  const [loaded, setLoaded] = React.useState<{ key?: string; snapshot?: OrchestrationRunSnapshot; error?: string }>({});
  React.useEffect(() => {
    let canceled = false;
    setLoaded((cur) => (cur.key === readKey ? cur : { key: readKey }));
    readOrchestrationRunSnapshot(api, { runId: state.runId })
      .then((snapshot) => {
        if (!canceled) setLoaded({ key: readKey, snapshot });
      })
      .catch((err: any) => {
        if (!canceled) setLoaded({ key: readKey, error: String(err?.message ?? err) });
      });
    return () => { canceled = true; };
  }, [api, readKey, state.runId]);

  const model = React.useMemo(() => (
    loaded.key === readKey && loaded.snapshot
      ? buildOrchestrationRunViewModelFromSnapshot(api, boardId, board, state, loaded.snapshot)
      : undefined
  ), [api, boardId, board, loaded.key, loaded.snapshot, readKey, state]);

  if (!model) return <RolePanel state={state} />;
  return (
    <CardTableau
      model={model}
      onPlayArchetype={async (id) => {
        await materializeManualOrchestrationArchetype(api as OrchestrationApi, boardId, board, state, id);
      }}
      controls={({ openCard }) => (
        <SteeringControls
          boardId={boardId}
          board={board}
          api={api as OrchestrationApi & Pick<BoardPluginApi, 'patchBoard'>}
          state={state}
          model={model}
          onOpenCard={openCard}
        />
      )}
    />
  );
}

type CardTableauControls = { selectedId?: string; openCard(boardId: string): void };

export type OrchestrationArchetypeId =
  | 'boss'
  | 'lead'
  | 'worker'
  | 'inspector'
  | 'consul'
  | 'enforcer'
  | 'scout'
  | 'fixer';

interface OrchestrationCardArchetype {
  id: OrchestrationArchetypeId;
  name: string;
  roleName: string;
  rank: string;
  arch: string;
  glyph: string;
  gem: string;
  tagline: string;
  produces: string;
  blurb: string;
  engineRole: OrchestrationRole;
  defaultStage: OrchestrationStage;
}

const ORCHESTRATION_CARD_ARCHETYPES: readonly OrchestrationCardArchetype[] = [
  {
    id: 'boss',
    name: 'THE BOSS',
    roleName: '架构总管',
    rank: '指挥官',
    arch: '指挥 · Commander',
    glyph: '🦍',
    gem: '#d6362b',
    tagline: '听需求 · 定目标与验收 · 每一步决定派谁',
    produces: '纲领 + 一路上的出牌决策',
    blurb: '读懂需求，定下目标和验收线，然后边看局面边决定打谁上场。',
    engineRole: 'architect',
    defaultStage: 'planning',
  },
  {
    id: 'lead',
    name: 'THE LIEUTENANT',
    roleName: '工程大档',
    rank: '军官',
    arch: '军官 · Officer',
    glyph: '🐒',
    gem: '#e0a02a',
    tagline: '拆活 · 现场决定派几个打手 · 整合',
    produces: '工作包 + 汇总集成',
    blurb: '把活拆成互不打架的包，当场决定并行派几个执行者，最后并回来。',
    engineRole: 'leadEngineer',
    defaultStage: 'execution',
  },
  {
    id: 'worker',
    name: 'THE WORKHORSE',
    roleName: '施工打手',
    rank: '工兵',
    arch: '工兵 · Worker',
    glyph: '🐂',
    gem: '#e7d8ad',
    tagline: '干一个划好范围的活',
    produces: '代码改动 + 交活报告',
    blurb: '拿到明确范围就动手。越界或卡住就停下上报。',
    engineRole: 'workerEngineer',
    defaultStage: 'worker',
  },
  {
    id: 'inspector',
    name: 'THE INSPECTOR',
    roleName: '验货人',
    rank: '专家·可否决',
    arch: '专家 · 可否决',
    glyph: '🦉',
    gem: '#2f9e5b',
    tagline: '照验收线写测试 · 逐条跑 · 挂了就现打补锅匠',
    produces: '测试判决（可否决）',
    blurb: '照验收线写测试并逐条运行。没过就打回并说明该修哪里。',
    engineRole: 'testEngineer',
    defaultStage: 'test',
  },
  {
    id: 'consul',
    name: 'THE CONSIGLIERE',
    roleName: '终审顾问',
    rank: '专家·可否决',
    arch: '专家 · 可否决',
    glyph: '🦊',
    gem: '#2f6ea0',
    tagline: '审覆盖 · 审架构 · 审风险',
    produces: '终审判决（可否决）',
    blurb: '最后过一遍覆盖、架构和残余风险，通过后才向用户汇报。',
    engineRole: 'reviewer',
    defaultStage: 'review',
  },
  {
    id: 'enforcer',
    name: 'THE ENFORCER',
    roleName: '安全打手长',
    rank: '专家·可否决',
    arch: '专家 · 可否决',
    glyph: '🦂',
    gem: '#b32b22',
    tagline: '安全审计',
    produces: '安全判决（可否决）',
    blurb: '专盯注入、鉴权绕过、密钥泄漏和危险操作，发现问题直接叫停。',
    engineRole: 'reviewer',
    defaultStage: 'review',
  },
  {
    id: 'scout',
    name: 'THE SCOUT',
    roleName: '探子',
    rank: '工兵',
    arch: '工兵 · Worker',
    glyph: '🦝',
    gem: '#3f9e93',
    tagline: '动手前摸清现状 · 查资料',
    produces: '情报简报',
    blurb: '开干前先摸清现有代码、外部接口和风险点，只交付调查简报。',
    engineRole: 'workerEngineer',
    defaultStage: 'worker',
  },
  {
    id: 'fixer',
    name: 'THE FIXER',
    roleName: '补锅匠',
    rank: '工兵',
    arch: '工兵 · Worker',
    glyph: '🐀',
    gem: '#c98a3a',
    tagline: '修被验货打回的地方',
    produces: '定点修复 + 复验',
    blurb: '只修被点名的问题，不扩大范围，修完交回复验。',
    engineRole: 'workerEngineer',
    defaultStage: 'repair',
  },
] as const;

const ARCHETYPE_BY_ROLE: Record<OrchestrationRole, OrchestrationArchetypeId> = {
  architect: 'boss',
  leadEngineer: 'lead',
  workerEngineer: 'worker',
  testEngineer: 'inspector',
  reviewer: 'consul',
};

function archetypeById(id: OrchestrationArchetypeId): OrchestrationCardArchetype {
  return ORCHESTRATION_CARD_ARCHETYPES.find((entry) => entry.id === id) ?? ORCHESTRATION_CARD_ARCHETYPES[0];
}

function archetypeForRole(role: OrchestrationRole): OrchestrationCardArchetype {
  return archetypeById(ARCHETYPE_BY_ROLE[role]);
}

function archetypeForCard(card: Pick<RunCardNode, 'role' | 'stage' | 'packageTitle'>): OrchestrationCardArchetype {
  if (card.packageTitle === 'THE ENFORCER') return archetypeById('enforcer');
  if (card.packageTitle === 'THE SCOUT') return archetypeById('scout');
  if (card.packageTitle === 'THE FIXER' || card.stage === 'repair') return archetypeById('fixer');
  return archetypeForRole(card.role);
}

// A selection is valid only while it still points at a live card. A deliberate close
// (selectedId === undefined) is NOT selectable, so the reset effect must not treat it as
// "stale" and re-open the dossier. (review fix — the old effect re-asserted the focused card.)
export function isSelectableCard(selectedId: string | undefined, cards: RunCardNode[]): boolean {
  return !!selectedId && cards.some((card) => card.boardId === selectedId);
}

export function CardTableau({
  model,
  controls,
  onPlayArchetype,
  initialSelectedId,
}: {
  model: RunViewModel;
  controls?: React.ReactNode | ((actions: CardTableauControls) => React.ReactNode);
  onPlayArchetype?: (id: OrchestrationArchetypeId) => void | Promise<void>;
  initialSelectedId?: string;
}) {
  // The dossier is a modal: CLOSED by default, opened by clicking a card (mockup parity —
  // the mockup's default view is the command tree, the exec档 is a centered modal you open).
  // `initialSelectedId` lets SSR tests render it open; the runtime never passes it.
  const [selectedId, setSelectedId] = React.useState<string | undefined>(
    initialSelectedId && model.cards.some((card) => card.boardId === initialSelectedId) ? initialSelectedId : undefined,
  );
  const [mode, setMode] = React.useState<'table' | 'deck' | 'debug'>('table');
  const openCard = React.useCallback((id: string) => setSelectedId(id), []);
  React.useEffect(() => {
    // Only clear a selection whose board vanished mid-run. A deliberate close leaves
    // selectedId === undefined and must STAY closed — re-asserting initialSelected here
    // re-opened the dossier the user just dismissed. (review fix; e2e regression guards it)
    if (selectedId && !isSelectableCard(selectedId, model.cards)) setSelectedId(undefined);
  }, [model.cards, selectedId]);
  const cardIds = new Set(model.cards.map((card) => card.boardId));
  const selectedCard = selectedId ? model.cards.find((card) => card.boardId === selectedId) : undefined;
  const controlContent = typeof controls === 'function' ? controls({ selectedId, openCard }) : controls;
  const mission = missionSummary(model);
  const bubblesBySource = new Map<string, BubbleEvent[]>();
  const looseBubbles: BubbleEvent[] = [];
  for (const bubble of model.bubbles) {
    if (bubble.sourceBoardId && cardIds.has(bubble.sourceBoardId)) {
      const list = bubblesBySource.get(bubble.sourceBoardId) ?? [];
      list.push(bubble);
      bubblesBySource.set(bubble.sourceBoardId, list);
    } else {
      looseBubbles.push(bubble);
    }
  }
  const latestSourcedBubble = latestBubbleForCard([...bubblesBySource.values()].flat());
  return (
    <div className="orchestration-orch orch nodrag nopan" style={{ flexShrink: 0, padding: 12, borderBottom: '1px solid #3c2f1d', background: '#11100e', color: '#e5d7b8', fontSize: 12 }}>
      <div className="orchestration-orch__bar orch__hd" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, marginBottom: 10 }}>
        <span className="orch__ti" style={{ color: '#f1d28c', fontWeight: 900, letterSpacing: 0, textTransform: 'uppercase' }}>Orchestration</span>
        <span style={{ color: '#8f866f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.runId}</span>
        <span style={{ color: '#7fcaa0', fontWeight: 800, whiteSpace: 'nowrap' }}>{model.cards.length} cards</span>
        <div className="orchestration-mode-switch seg" role="tablist" aria-label="Orchestration view mode" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 3, border: '1px solid #4a3820', background: '#0b0b0a', borderRadius: 6, padding: 3 }}>
          <button
            type="button"
            className={`orchestration-mode-tab orchestration-mode-tab--table${mode === 'table' ? ' orchestration-mode-tab--active' : ''}`}
            aria-selected={mode === 'table'}
            onClick={() => setMode('table')}
            style={modeTabStyle(mode === 'table')}
          >
            牌桌
          </button>
          <button
            type="button"
            className={`orchestration-mode-tab orchestration-mode-tab--deck${mode === 'deck' ? ' orchestration-mode-tab--active' : ''}`}
            aria-selected={mode === 'deck'}
            onClick={() => setMode('deck')}
            style={modeTabStyle(mode === 'deck')}
          >
            牌库
          </button>
          <button
            type="button"
            className={`orchestration-mode-tab orchestration-mode-tab--debug${mode === 'debug' ? ' orchestration-mode-tab--active' : ''}`}
            aria-selected={mode === 'debug'}
            onClick={() => setMode('debug')}
            style={modeTabStyle(mode === 'debug')}
          >
            Debug
          </button>
        </div>
      </div>
      {controlContent ? <div className="orchestration-steering-slot" style={{ marginBottom: 10 }}>{controlContent}</div> : null}
      <section className="orchestration-mode-table view view--table" data-active={mode === 'table'} hidden={mode !== 'table'}>
        <MissionStrip mission={mission} />
        <div
          className="orchestration-command-stage stage"
          style={{
            position: 'relative',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(190px, 250px)',
            gap: 12,
            minHeight: 280,
            maxHeight: 'min(58vh, 520px)',
            overflow: 'hidden',
            border: '1px solid #6f5528',
            background: 'linear-gradient(180deg, #18140d, #0d0d0c)',
            borderRadius: 7,
            padding: 10,
            boxShadow: 'inset 0 0 0 1px rgba(255,214,132,.08), 0 14px 32px rgba(0,0,0,.28)',
          }}
        >
          <ScopedIntelWires entries={model.scopedIntel} readerBoardId={selectedId ?? model.focusedBoardId ?? model.cards[0]?.boardId} />
          <div className="orchestration-tree-scroll orchestration-tree tree" style={{ position: 'relative', zIndex: 1, minWidth: 0, overflow: 'auto', padding: '10px 6px 12px' }}>
            <OrgTree
              cards={model.cards}
              bubblesBySource={bubblesBySource}
              latestSourcedBubbleId={latestSourcedBubble?.id}
              selectedId={selectedId}
              openCard={openCard}
            />
            {looseBubbles.length ? (
              <div className="orchestration-speech-loose" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {looseBubbles.map((bubble) => <SpeechBalloon key={bubble.id} bubble={bubble} loose />)}
              </div>
            ) : null}
          </div>
          <div className="orchestration-intel-slot intel" style={{ position: 'relative', zIndex: 1, minWidth: 0, minHeight: 0 }}>
            <ScopedIntelRail entries={model.scopedIntel} />
          </div>
        </div>
        <ExecutionDossier card={selectedCard} onClose={() => setSelectedId(undefined)} />
      </section>
      <section className="orchestration-mode-deck view view--deck" data-active={mode === 'deck'} hidden={mode !== 'deck'}>
        <div className="zone__t" style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '4px 0 10px', color: '#e9d7a5' }}>
          <strong style={{ color: '#f1d28c', textTransform: 'uppercase' }}>牌库是</strong>
          <span style={{ color: '#928774' }}>所有可手动出牌的 UI 身份；落地时仍映射到现有 engine roles。</span>
        </div>
        <div className="grid deck orchestration-deck" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          {ORCHESTRATION_CARD_ARCHETYPES.map((archetype) => (
            <DeckCard
              key={archetype.id}
              archetype={archetype}
              onPlay={onPlayArchetype ? () => onPlayArchetype(archetype.id) : undefined}
            />
          ))}
        </div>
      </section>
      <section className="orchestration-mode-debug" data-active={mode === 'debug'} hidden={mode !== 'debug'}>
        <DebugRunView model={model} />
      </section>
    </div>
  );
}

export function SteeringControls({ boardId, board, api, state, model, onOpenCard }: { boardId: string; board: BoardData; api: OrchestrationApi & Pick<BoardPluginApi, 'patchBoard'>; state: OrchestrationState; model: RunViewModel; onOpenCard?: (boardId: string) => void }) {
  const liveCards = model.cards.filter((card) => {
    const b = api.getBoard?.(card.boardId);
    return b?.status === 'streaming' || b?.status === 'waiting';
  });
  return (
    <div className="orchestration-steering bsteer orchestration-bsteer" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', border: '1px solid #5d4724', background: '#120d08', borderRadius: 6, padding: 8 }}>
      <span style={{ color: '#c9a86a', fontWeight: 900, fontSize: 11, textTransform: 'uppercase' }}>Steering</span>
      <RoleActions boardId={boardId} board={board} api={api} state={state} />
      {liveCards.length ? (
        <div className="orchestration-live-cards" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ color: '#ffd58a', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>Live</span>
          {liveCards.map((card) => (
            <button
              key={card.boardId}
              type="button"
              className="orchestration-live-card stbtn orchestration-stbtn"
              title={`Open ${card.roleLabel} execution report. Use the board Stop control to stop this live board.`}
              onClick={() => onOpenCard?.(card.boardId)}
              style={{
                border: '1px solid #4b3a1e',
                background: '#211b13',
                color: '#ffd58a',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 11,
                fontWeight: 800,
                cursor: 'pointer',
                display: 'inline-flex',
                gap: 5,
                alignItems: 'center',
                maxWidth: 180,
                minWidth: 0,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.roleLabel}</span>
              <span style={{ color: '#9d9486', fontWeight: 700 }}>{card.boardId}</span>
            </button>
          ))}
          <span className="orchestration-steering-stop-note stbtn orchestration-stbtn orchestration-stbtn--no" style={{ color: '#e0796f', border: '1px solid #5e130f', background: '#1c140a', borderRadius: 4, padding: '2px 8px', fontSize: 11 }}>
            Use the board <strong>Stop</strong> control.
          </span>
        </div>
      ) : null}
    </div>
  );
}

// Org-chart command tree (mockup `.tree`): nested ul/li built from real parent/child lineage, so the
// gold connector lines (CSS `.tree li::before/::after`) draw the actual command hierarchy.
function OrgTree({ cards, bubblesBySource, latestSourcedBubbleId, selectedId, openCard }: {
  cards: RunCardNode[];
  bubblesBySource: Map<string, BubbleEvent[]>;
  latestSourcedBubbleId?: string;
  selectedId?: string;
  openCard(id: string): void;
}) {
  const byId = new Map(cards.map((c) => [c.boardId, c]));
  const childrenOf = new Map<string, RunCardNode[]>();
  const roots: RunCardNode[] = [];
  for (const c of cards) {
    const parent = c.parentBoardId && c.parentBoardId !== c.boardId && byId.has(c.parentBoardId) ? c.parentBoardId : undefined;
    if (parent) {
      const list = childrenOf.get(parent) ?? [];
      list.push(c);
      childrenOf.set(parent, list);
    } else {
      roots.push(c);
    }
  }
  const seen = new Set<string>();
  const renderNode = (card: RunCardNode): React.ReactNode => {
    if (seen.has(card.boardId)) return null;
    seen.add(card.boardId);
    const kids = (childrenOf.get(card.boardId) ?? []).filter((k) => !seen.has(k.boardId));
    const cardBubbles = bubblesBySource.get(card.boardId) ?? [];
    const speaking = cardBubbles.length > 0 && latestBubbleForCard(cardBubbles)?.id === latestSourcedBubbleId;
    return (
      <li key={card.boardId}>
        <div className="orchestration-card-speech-anchor" style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <RoleCard card={card} selected={card.boardId === selectedId} speaking={speaking} onOpen={() => openCard(card.boardId)} />
          <SpeechEvents bubbles={cardBubbles} />
        </div>
        {kids.length ? <ul>{kids.map(renderNode)}</ul> : null}
      </li>
    );
  };
  return <ul>{roots.map(renderNode)}</ul>;
}

function RoleCard({ card, selected, speaking, onOpen }: { card: RunCardNode; selected: boolean; speaking?: boolean; onOpen(): void }) {
  const tone = statusTone(card.status);
  const archetype = archetypeForCard(card);
  const statusClass = statusClassName(card.status);
  return (
    <button
      type="button"
      className={`mc${speaking ? ' speaking' : ''} orchestration-card mc--${archetype.id} st-${statusClass}${selected ? ' selected' : ''}`}
      title={`${archetype.name}\n${card.roleLabel} · ${card.stageLabel}\n${card.statusLabel}`}
      onClick={onOpen}
      style={{
        ...archetypeCssVars(archetype),
        appearance: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        position: 'relative',
        minHeight: 148,
        width: 156,
        maxWidth: '100%',
        alignSelf: 'center',
        border: `1px solid ${selected ? '#f0c46a' : '#5a4523'}`,
        background: `linear-gradient(180deg, ${tone.surface}, #120f0a)`,
        boxShadow: selected
          ? '0 0 0 1px rgba(240,196,106,.44), 0 14px 28px rgba(0,0,0,.3)'
          : card.status === 'running' ? `0 0 0 1px ${tone.glow}, 0 0 22px ${tone.glow}` : '0 10px 24px rgba(0,0,0,.22)',
        borderRadius: 5,
        padding: 7,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <div className="mc__b" style={{ border: '1px solid rgba(229,192,111,.48)', background: 'linear-gradient(180deg, rgba(20,17,12,.96), rgba(10,9,8,.96))', borderRadius: 5, minHeight: 132, width: '100%', padding: 5, boxSizing: 'border-box' }}>
        <div className="mc__f" style={{ position: 'relative', minHeight: 120, border: '1px solid rgba(92,72,37,.82)', background: 'radial-gradient(circle at 50% 20%, rgba(255,255,255,.08), transparent 34%), #14110c', borderRadius: 4, padding: 6, display: 'grid', gridTemplateRows: '58px auto', gap: 6, overflow: 'hidden' }}>
          <span className="gem" aria-hidden="true" style={{ position: 'absolute', top: 6, left: 6, width: 9, height: 9, transform: 'rotate(45deg)', background: archetype.gem, border: '1px solid rgba(255,238,188,.72)', boxShadow: `0 0 12px ${archetype.gem}` }} />
          <span className={`mc__stat ss-${statusClass}`} style={{ position: 'absolute', top: 5, right: 5, color: tone.text, border: `1px solid ${tone.border}`, background: tone.badge, borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 900, whiteSpace: 'nowrap' }}>
            {card.statusLabel}
          </span>
          <CardArt archetype={archetype} className="mc__art" size="mini" />
          <div className="mc__pl" style={{ minWidth: 0, textAlign: 'center', display: 'grid', gap: 2 }}>
            <div className="mc__nm" style={{ color: '#f3e0aa', fontWeight: 900, fontSize: 11, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archetype.name}</div>
            <div className="mc__rl" style={{ color: '#b9a785', fontSize: 10, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.packageTitle && card.packageTitle !== archetype.name ? card.packageTitle : archetype.roleName}</div>
            <div style={{ color: '#766a58', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {card.parentBoardId ? `from ${card.parentBoardId}` : card.stageLabel}
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}

function CardArt({ archetype, className, size }: { archetype: OrchestrationCardArchetype; className: string; size: 'mini' | 'deck' | 'dossier' }) {
  const fontSize = size === 'mini' ? 30 : size === 'deck' ? 45 : 38;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        minHeight: size === 'mini' ? 58 : size === 'deck' ? 92 : 86,
        border: '1px solid rgba(199,155,70,.6)',
        borderRadius: 5,
        display: 'grid',
        placeItems: 'center',
        background: `radial-gradient(circle at 50% 35%, ${archetype.gem}33, transparent 45%), linear-gradient(180deg, #1c1710, #0d0b08)`,
        overflow: 'hidden',
      }}
    >
      <span className="bld" aria-hidden="true" style={{ position: 'absolute', inset: 7, border: `1px solid ${archetype.gem}`, opacity: .42, borderRadius: 4 }} />
      <span className="pf" aria-hidden="true" style={{ position: 'relative', zIndex: 1, fontSize, lineHeight: 1, filter: 'drop-shadow(0 8px 12px rgba(0,0,0,.42))' }}>{archetype.glyph}</span>
      <span className="gr" aria-hidden="true" style={{ position: 'absolute', left: '18%', right: '18%', bottom: size === 'mini' ? 9 : 14, height: 8, borderRadius: '50%', background: `radial-gradient(ellipse, ${archetype.gem}88, transparent 72%)` }} />
      <span className="vg" aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 42%, transparent 42%, rgba(0,0,0,.42) 100%)' }} />
    </div>
  );
}

function archetypeCssVars(archetype: OrchestrationCardArchetype): React.CSSProperties {
  return { '--g': archetype.gem } as React.CSSProperties;
}

function modeTabStyle(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? '#b88935' : 'transparent'}`,
    background: active ? '#2d2112' : 'transparent',
    color: active ? '#ffd98a' : '#9c927f',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    fontWeight: 900,
    cursor: 'pointer',
  };
}

function statusClassName(status: CardExecutionStatus): string {
  switch (status) {
    case 'running': return 'work';
    case 'delivered': return 'done';
    case 'passed': return 'pass';
    case 'rejected': return 'reject';
    case 'blocked': return 'veto';
    case 'queued':
    default:
      return 'queued';
  }
}

function missionSummary(model: RunViewModel): { title: string; stage: string; progress: number } {
  const selected = model.cards.find((card) => card.boardId === model.focusedBoardId) ?? model.cards[0];
  const complete = model.cards.filter((card) => card.status === 'delivered' || card.status === 'passed').length;
  const progress = model.cards.length ? Math.round((complete / model.cards.length) * 100) : 0;
  const running = model.cards.find((card) => card.status === 'running');
  const stage = running?.stageLabel ?? selected?.stageLabel ?? 'Orchestration';
  return {
    title: selected?.packageTitle || selected?.title || model.runId,
    stage,
    progress,
  };
}

function MissionStrip({ mission }: { mission: { title: string; stage: string; progress: number } }) {
  return (
    <div className="orchestration-mission mission" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 12, alignItems: 'center', border: '1px solid #5d4724', background: 'linear-gradient(180deg, #17120b, #0f0d0a)', borderRadius: 7, padding: '8px 10px', marginBottom: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
          <span style={{ color: '#f1d28c', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>MISSION</span>
          <strong style={{ color: '#ecdfbf', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mission.title}</strong>
          <span style={{ color: '#8fc7a6', fontWeight: 800, whiteSpace: 'nowrap' }}>{mission.stage}</span>
        </div>
        <div className="bar" style={{ height: 5, marginTop: 7, borderRadius: 999, background: '#252019', overflow: 'hidden', border: '1px solid #3b3020' }}>
          <span style={{ display: 'block', height: '100%', width: `${mission.progress}%`, background: 'linear-gradient(90deg, #c9962f, #7fcaa0)' }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <span className="sw" style={{ color: '#b9ab90', border: '1px solid #3b3020', background: '#15120e', borderRadius: 12, padding: '2px 7px', fontSize: 11, whiteSpace: 'nowrap' }}>自动放行 · 每个命令你仍可拦</span>
        <button type="button" className="btn btn--go" disabled title="Restart is controlled from the source board, not this panel yet" style={{ border: '1px solid #5b451f', background: '#241b0f', color: '#b9a678', borderRadius: 5, padding: '4px 8px', fontSize: 11, fontWeight: 900, cursor: 'default', opacity: .55 }}>↻ 重来</button>
      </div>
    </div>
  );
}

function DeckCard({ archetype, onPlay }: { archetype: OrchestrationCardArchetype; onPlay?: () => void | Promise<void> }) {
  return (
    <article className={`card card--${archetype.id}`} data-id={archetype.id} style={{ ...archetypeCssVars(archetype), border: '1px solid #5d4724', background: 'linear-gradient(180deg, #18140d, #0e0d0b)', borderRadius: 6, padding: 8, boxShadow: '0 12px 28px rgba(0,0,0,.24)' }}>
      <div className="card__b" style={{ border: '1px solid rgba(229,192,111,.42)', borderRadius: 5, padding: 5 }}>
        <div className="card__f" style={{ position: 'relative', border: '1px solid #4b3a1e', borderRadius: 4, padding: 8, minHeight: 188, display: 'grid', gridTemplateRows: '96px auto auto', gap: 7, background: '#14110c', overflow: 'hidden' }}>
          <span className="gem" aria-hidden="true" style={{ position: 'absolute', top: 7, left: 7, width: 10, height: 10, transform: 'rotate(45deg)', background: archetype.gem, border: '1px solid rgba(255,238,188,.72)', boxShadow: `0 0 12px ${archetype.gem}` }} />
          <CardArt archetype={archetype} className="art" size="deck" />
          <div className="pl" style={{ minWidth: 0, textAlign: 'center' }}>
            <div className="nm" style={{ color: '#f3e0aa', fontWeight: 900, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archetype.name}</div>
            <div className="rl" style={{ color: '#c7b38a', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archetype.roleName}</div>
            <div className="rk" style={{ color: '#81786d', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archetype.rank}</div>
          </div>
          <div style={{ color: '#a99d89', fontSize: 10, lineHeight: 1.35, minHeight: 40, overflowWrap: 'anywhere' }}>{archetype.tagline}</div>
          <button
            type="button"
            className="btn btn--go orchestration-deck-play"
            disabled={!onPlay}
            onClick={onPlay}
            title={`Materialize ${archetype.name} as ${roleLabel(archetype.engineRole)}`}
            style={{ border: '1px solid #7c5b23', background: '#2d2112', color: '#ffd98a', borderRadius: 5, padding: '4px 8px', fontSize: 11, fontWeight: 900, cursor: onPlay ? 'pointer' : 'default', opacity: onPlay ? 1 : .62 }}
          >
            ▶ 打出到牌桌
          </button>
        </div>
      </div>
    </article>
  );
}

function latestBubbleForCard(bubbles: BubbleEvent[]): BubbleEvent | undefined {
  return [...bubbles].sort((a, b) => b.seq - a.seq)[0];
}

function SpeechEvents({ bubbles }: { bubbles: BubbleEvent[] }) {
  if (!bubbles.length) return null;
  const visible = bubbles.slice(-4);
  return (
    <div className="orchestration-speech-events" style={{ display: 'flex', flexDirection: 'column', gap: 5, position: 'relative' }}>
      {visible.map((bubble) => (
        bubble.relation === 'peer'
          ? <PeerLink key={bubble.id} bubble={bubble} />
          : <SpeechBalloon key={bubble.id} bubble={bubble} />
      ))}
      {bubbles.length > visible.length ? (
        <div style={{ color: '#756e64', fontSize: 10, paddingLeft: 4 }}>+{bubbles.length - visible.length} more</div>
      ) : null}
    </div>
  );
}

function SpeechBalloon({ bubble, loose = false }: { bubble: BubbleEvent; loose?: boolean }) {
  const tone = bubbleTone(bubble.kind, bubble.relation);
  const bbClass = bubble.kind === 'order'
    ? 'bb-order'
    : bubble.kind === 'report'
      ? 'bb-report'
      : bubble.kind === 'verdict'
        ? bubble.text.toLowerCase().includes('pass') ? 'bb-pass' : 'bb-reject'
        : 'bb-peer';
  return (
    <div
      className={`balloon in ${bbClass} orchestration-balloon orchestration-balloon--${bubble.kind} orchestration-balloon--${bubble.relation}${loose ? ' orchestration-balloon--loose' : ''}`}
      title={`${bubble.kind} · ${bubble.relation}`}
      style={{
        alignSelf: bubble.relation === 'up' ? 'flex-start' : bubble.relation === 'down' ? 'flex-end' : 'center',
        maxWidth: '100%',
        color: tone.text,
        border: `1px solid ${tone.border}`,
        background: tone.background,
        borderRadius: '8px 8px 8px 3px',
        padding: '6px 8px',
        fontSize: 11,
        lineHeight: 1.35,
        boxShadow: '0 8px 18px rgba(0,0,0,.18)',
        overflowWrap: 'anywhere',
        position: 'relative',
      }}
    >
      <span className="orchestration-balloon__tail balloon__tail" aria-hidden="true" style={{ position: 'absolute', width: 7, height: 7, bottom: -4, left: bubble.relation === 'down' ? undefined : 10, right: bubble.relation === 'down' ? 10 : undefined, transform: 'rotate(45deg)', background: tone.background, borderRight: `1px solid ${tone.border}`, borderBottom: `1px solid ${tone.border}` }} />
      <span className="orchestration-balloon__role" style={{ color: '#f1d28c', fontWeight: 900, marginRight: 5, textTransform: 'uppercase' }}>{bubble.kind}</span>
      <span className="orchestration-balloon__relation" style={{ fontWeight: 900, marginRight: 5 }}>{relationGlyph(bubble.relation)}</span>
      {bubble.text}
    </div>
  );
}

function PeerLink({ bubble }: { bubble: BubbleEvent }) {
  return (
    <div
      className="peerlink in orchestration-peerlink"
      title={`peer · ${bubble.sourceBoardId ?? '?'} -> ${bubble.targetBoardId ?? '?'}`}
      style={{
        alignSelf: 'center',
        maxWidth: '100%',
        color: '#8fe3d6',
        borderTop: '2px dashed #4ca799',
        paddingTop: 5,
        fontSize: 11,
        lineHeight: 1.35,
        overflowWrap: 'anywhere',
        textAlign: 'center',
        textShadow: '0 0 10px rgba(111,208,192,.28)',
      }}
    >
      <span className="peerlink__b">
        <span className="orchestration-peerlink__badge" style={{ display: 'inline-block', border: '1px solid #347f74', background: '#10241f', borderRadius: 10, padding: '1px 7px', color: '#92e8da', fontWeight: 900 }}>
          peer
        </span>
        <span style={{ marginLeft: 6 }}>{bubble.text}</span>
      </span>
    </div>
  );
}

function ScopedIntelWires({ entries, readerBoardId }: { entries: ScopedIntelEntry[]; readerBoardId?: string }) {
  const wires = entries.filter((entry) => entry.producerBoardId && readerBoardId && entry.producerBoardId !== readerBoardId);
  if (!wires.length || !readerBoardId) return null;
  return (
    <svg
      className="wires orchestration-wires"
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 10, width: 'calc(100% - 20px)', height: 'calc(100% - 20px)', pointerEvents: 'none', zIndex: 0, overflow: 'visible' }}
    >
      {wires.map((entry, index) => {
        const y = 18 + (index % 5) * 14;
        return (
          <line
            key={`${entry.blockId}:${entry.producerBoardId}:${readerBoardId}`}
            className="wire in orchestration-wire"
            data-artifact={entry.blockId}
            data-producer={entry.producerBoardId}
            data-reader={readerBoardId}
            x1="7"
            y1={y}
            x2="91"
            y2={Math.min(92, y + 10)}
            stroke={intelTierColor(entry.tier)}
            strokeWidth="0.45"
            strokeDasharray={entry.tier === 'private' ? '2 2' : undefined}
            opacity=".55"
          />
        );
      })}
    </svg>
  );
}

function ScopedIntelRail({ entries }: { entries: ScopedIntelEntry[] }) {
  const byTier = new Map<ScopedIntelTier, ScopedIntelEntry[]>();
  for (const entry of entries) {
    const list = byTier.get(entry.tier) ?? [];
    list.push(entry);
    byTier.set(entry.tier, list);
  }
  const tiers: ScopedIntelTier[] = ['run-wide', 'role-scoped', 'private'];
  return (
    <aside
      className="orchestration-intel"
      style={{
        height: '100%',
        minHeight: 0,
        borderLeft: '1px solid #5d4724',
        background: 'linear-gradient(180deg, rgba(201,150,47,.05), rgba(10,10,9,.18))',
        padding: '9px 9px 10px 10px',
        overflow: 'auto',
      }}
    >
      <div className="orchestration-intel__title" style={{ color: '#f1d28c', fontWeight: 900, marginBottom: 8, textTransform: 'uppercase', fontSize: 11, lineHeight: 1.35 }}>
        Scoped Intel
      </div>
      {tiers.map((tier) => {
        const tierEntries = byTier.get(tier) ?? [];
        return (
          <section key={tier} className={`orchestration-tier orchestration-tier--${intelTierClass(tier)}`} style={{ borderLeft: `3px solid ${intelTierColor(tier)}`, background: intelTierBackground(tier), borderRadius: 6, padding: '6px 8px 7px', marginBottom: 8, marginLeft: tier === 'role-scoped' ? 8 : tier === 'private' ? 16 : 0 }}>
            <div className="orchestration-tier__label" style={{ color: intelTierColor(tier), fontSize: 10, fontWeight: 900, textTransform: 'uppercase', marginBottom: 6 }}>
              {intelTierLabel(tier)}
            </div>
            <div className="orchestration-tier__row" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tierEntries.length
                ? tierEntries.map((entry) => <ScopedIntelCard key={entry.blockId} entry={entry} />)
                : <div className="orchestration-tier__empty" style={{ color: '#756e64', fontSize: 11 }}>None</div>}
            </div>
          </section>
        );
      })}
    </aside>
  );
}

function ScopedIntelCard({ entry }: { entry: ScopedIntelEntry }) {
  const producer = entry.producerRole ? roleLabel(entry.producerRole) : entry.producerBoardId;
  const hasProducer = Boolean(producer);
  return (
    <div
      className={`orchestration-cardx art sc-${intelTierClass(entry.tier)}${hasProducer ? ' orchestration-cardx--produced' : ''} orchestration-cardx__read`}
      title={entry.content}
      style={{
        border: `1px solid ${hasProducer ? '#6b552d' : '#2c2925'}`,
        background: '#18150f',
        borderRadius: 5,
        padding: '5px 8px',
        minWidth: 0,
        boxShadow: hasProducer ? '0 0 0 1px rgba(232,198,94,.18)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: '#ece2ce', fontWeight: 900, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title}</div>
          <div className="orchestration-cardx__producer" style={{ color: '#81786d', fontSize: 10, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {producer ? `by ${producer}` : 'producer unknown'}
          </div>
        </div>
        <span className="orchestration-cardx__scope" style={{ flex: '0 0 auto', color: '#11100e', background: intelTierColor(entry.tier), borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 900 }}>
          {intelScopeLabel(entry)}
        </span>
        <span className="orchestration-cardx__read" title="Visible/readable in this rail" style={{ flex: '0 0 auto', color: '#f1d28c', fontSize: 10, fontWeight: 900 }}>
          read
        </span>
      </div>
      <div style={{ color: '#b7aea1', fontSize: 11, lineHeight: 1.35, marginTop: 5, maxHeight: 76, overflow: 'auto', overflowWrap: 'anywhere' }}>
        {entry.content}
      </div>
    </div>
  );
}

function ExecutionDossier({ card, onClose }: { card: RunCardNode | undefined; onClose(): void }) {
  // Esc dismisses the modal — only while it is open (card present), so a closed dossier
  // never installs a global key listener that could steal Esc from other UI.
  React.useEffect(() => {
    if (!card) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, onClose]);
  if (!card) return null; // closed: nothing renders (the tree/canvas is the resting view)
  const report = card.report;
  const tone = statusTone(report.status);
  const archetype = archetypeForCard(card);
  const timelineItems = [...report.timeline].slice(0, 6);
  return (
    <div
      className="modal on orchestration-modal orchestration-modal--inline"
      role="dialog"
      aria-modal="true"
      aria-label={`${card.roleLabel} execution dossier`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ marginTop: 10, border: '1px solid #5d4724', background: 'rgba(9,8,6,.72)', borderRadius: 9, padding: 10 }}
    >
      <div className="sheet orchestration-sheet" style={{ position: 'relative', display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', gap: 14, alignItems: 'start', border: '1px solid #8c642b', borderTop: '2px solid #c9962f', background: 'linear-gradient(180deg, #17100a, #110b06)', borderRadius: 8, padding: 14, boxShadow: '0 18px 44px rgba(0,0,0,.45)' }}>
        <button
          type="button"
          className="orchestration-sheet__x"
          aria-label="Close execution dossier"
          onClick={onClose}
          style={{ position: 'absolute', top: 8, right: 9, width: 22, height: 22, borderRadius: 5, border: '1px solid #5d4724', background: '#1c140a', color: '#d8c7a6', cursor: 'pointer', lineHeight: 1 }}
        >
          x
        </button>
        <div className="card card--lg" style={{ ...archetypeCssVars(archetype), width: 88, minWidth: 0, border: '1px solid #5d4724', background: '#14110c', borderRadius: 6, padding: 5 }}>
          <div className="card__b" style={{ border: '1px solid rgba(229,192,111,.42)', borderRadius: 5, padding: 4 }}>
            <div className="card__f" style={{ border: '1px solid #4b3a1e', borderRadius: 4, padding: 5, display: 'grid', gap: 5 }}>
              <span className="gem" aria-hidden="true" style={{ width: 9, height: 9, transform: 'rotate(45deg)', background: archetype.gem, border: '1px solid rgba(255,238,188,.72)' }} />
              <CardArt archetype={archetype} className="art" size="dossier" />
              <div className="nm" style={{ color: '#f3e0aa', fontWeight: 900, fontSize: 10, textAlign: 'center', lineHeight: 1.1 }}>{archetype.name}</div>
            </div>
          </div>
        </div>
        <div className="sheet__info orchestration-dossier" style={{ minWidth: 0, paddingRight: 24 }}>
          <div style={{ color: '#f1d28c', fontWeight: 900, textTransform: 'uppercase', fontSize: 12, marginBottom: 3 }}>{archetype.name}</div>
          <div style={{ color: '#c99b57', fontSize: 12, marginBottom: 9 }}>{archetype.roleName} · {card.stageLabel}</div>
          <DossierKv label="Status">
            <span className="orchestration-dossier__status" style={{ color: tone.text, border: `1px solid ${tone.border}`, background: tone.badge, borderRadius: 4, padding: '1px 6px', fontWeight: 900 }}>
              {report.statusLabel}
            </span>
          </DossierKv>
          <DossierKv label="Order">
            {report.receivedOrder || <EmptyDossierText>No received order recorded.</EmptyDossierText>}
          </DossierKv>
          <DossierKv label="Artifacts">
            {report.artifacts.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
                {report.artifacts.map((artifact) => (
                  <div key={artifact.blockId} className="orchestration-dossier__artifact" style={{ border: '1px solid #3b3020', background: '#1a1815', borderRadius: 5, padding: 7, minWidth: 0 }}>
                    <div style={{ color: '#ece2ce', fontWeight: 900, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</div>
                    {artifact.scope ? <div style={{ color: '#81786d', fontSize: 10, marginTop: 2 }}>{artifact.scope}</div> : null}
                    <div style={{ color: '#b7aea1', fontSize: 11, lineHeight: 1.35, marginTop: 5, maxHeight: 58, overflow: 'auto', overflowWrap: 'anywhere' }}>{artifact.content}</div>
                  </div>
                ))}
              </div>
            ) : <EmptyDossierText>No produced artifacts recorded.</EmptyDossierText>}
          </DossierKv>
          <DossierKv label="Timeline">
            {timelineItems.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 120, overflow: 'auto' }}>
                {timelineItems.map((item) => (
                  <div key={item.id} className={`orchestration-dossier__step orchestration-dossier__step--${item.kind}`} style={{ display: 'grid', gridTemplateColumns: '54px minmax(0, 1fr)', gap: 7, minWidth: 0, color: '#bdb4a7', fontSize: 11, lineHeight: 1.35 }}>
                    <span style={{ color: '#756e64', fontWeight: 900 }}>{item.kind}</span>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.text}</span>
                  </div>
                ))}
                {report.timeline.length > timelineItems.length ? <div style={{ color: '#756e64', fontSize: 10 }}>+{report.timeline.length - timelineItems.length} more in Debug</div> : null}
              </div>
            ) : <EmptyDossierText>No action timeline recorded.</EmptyDossierText>}
          </DossierKv>
        </div>
      </div>
    </div>
  );
}

function DebugRunView({ model }: { model: RunViewModel }) {
  return (
    <div
      className="orchestration-debug"
      style={{
        maxHeight: 'min(62vh, 560px)',
        overflow: 'auto',
        border: '1px solid #3d3323',
        background: '#0d0d0c',
        borderRadius: 7,
        padding: 10,
        color: '#d7c9a8',
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, minWidth: 0 }}>
        <span style={{ color: '#f1d28c', fontWeight: 900, textTransform: 'uppercase' }}>Debug Run</span>
        <span style={{ color: '#8f866f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.runId}</span>
        <span style={{ marginLeft: 'auto', color: '#7fcaa0', fontWeight: 800 }}>{model.cards.length} boards</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {model.cards.map((card) => (
          <article key={card.boardId} className="orchestration-debug-card" style={{ border: '1px solid #2f2a22', background: '#141310', borderRadius: 5, padding: 9 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, marginBottom: 8 }}>
              <span style={{ color: '#f0dfb8', fontWeight: 900 }}>{card.roleLabel}</span>
              <span style={{ color: '#918671' }}>{card.stageLabel}</span>
              <span style={{ color: statusTone(card.status).text, fontWeight: 900 }}>{card.statusLabel}</span>
              <code style={{ marginLeft: 'auto', color: '#8b806c', fontSize: 10, overflowWrap: 'anywhere' }}>{card.boardId}</code>
            </div>
            <DebugField label="received order">
              {card.report.receivedOrder || 'No received order recorded.'}
            </DebugField>
            <DebugField label="produced artifacts">
              {card.report.artifacts.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {card.report.artifacts.map((artifact) => (
                    <div key={artifact.blockId} className="orchestration-debug-artifact" style={{ border: '1px solid #2c2925', background: '#1b1914', borderRadius: 4, padding: 7 }}>
                      <div style={{ color: '#ecdcae', fontWeight: 900 }}>{artifact.title}</div>
                      <div style={{ color: '#81786d', fontSize: 10 }}>{[artifact.scope, artifact.blockId].filter(Boolean).join(' · ')}</div>
                      <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{artifact.content}</div>
                    </div>
                  ))}
                </div>
              ) : 'No produced artifacts recorded.'}
            </DebugField>
            <DebugField label="action timeline">
              {card.report.timeline.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {card.report.timeline.map((item) => (
                    <div key={item.id} className={`orchestration-debug-step orchestration-debug-step--${item.kind}`} style={{ display: 'grid', gridTemplateColumns: '58px minmax(0, 1fr)', gap: 7 }}>
                      <span style={{ color: '#8b806c', fontWeight: 900 }}>{item.kind}</span>
                      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</span>
                    </div>
                  ))}
                </div>
              ) : 'No action timeline recorded.'}
            </DebugField>
          </article>
        ))}
      </div>
    </div>
  );
}

function DebugField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="orchestration-debug-field" style={{ marginTop: 8 }}>
      <div style={{ color: '#c9a86a', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#d0c3a6', whiteSpace: typeof children === 'string' ? 'pre-wrap' : undefined, overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </section>
  );
}

function DossierKv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="orchestration-dossier__kv" style={{ display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', gap: 10, margin: '8px 0', fontSize: 12, lineHeight: 1.45 }}>
      <b style={{ color: '#8f866f', fontWeight: 700 }}>{label}</b>
      <span style={{ color: '#d8c7a6', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

function EmptyDossierText({ children }: { children: React.ReactNode }) {
  return (
    <span className="orchestration-dossier__empty" style={{ color: '#756e64' }}>
      {children}
    </span>
  );
}

function cardDepths(cards: RunCardNode[]): Map<string, number> {
  const cardIds = new Set(cards.map((card) => card.boardId));
  const parentById = new Map(cards.map((card) => [card.boardId, card.parentBoardId]));
  const depthOf = (boardId: string, seen = new Set<string>()): number => {
    const parent = parentById.get(boardId);
    if (!parent || !cardIds.has(parent) || seen.has(boardId)) return 0;
    seen.add(boardId);
    return depthOf(parent, seen) + 1;
  };
  return new Map(cards.map((card) => [card.boardId, depthOf(card.boardId)]));
}

function statusTone(status: CardExecutionStatus): { text: string; border: string; badge: string; surface: string; glow: string } {
  switch (status) {
    case 'running': return { text: '#ffd58a', border: '#8f6b2b', badge: '#2f2514', surface: '#211b13', glow: 'rgba(221, 155, 62, .25)' };
    case 'delivered': return { text: '#9fdbb3', border: '#466854', badge: '#1f2d24', surface: '#19211b', glow: 'rgba(98, 190, 126, .18)' };
    case 'passed': return { text: '#b7f0c7', border: '#4f8f62', badge: '#1d3726', surface: '#18261c', glow: 'rgba(100, 220, 130, .2)' };
    case 'rejected': return { text: '#ffb099', border: '#8f4f3f', badge: '#341f19', surface: '#241715', glow: 'rgba(220, 92, 66, .2)' };
    case 'blocked': return { text: '#b8b0a6', border: '#5a534b', badge: '#24221f', surface: '#1b1a18', glow: 'rgba(120, 112, 104, .16)' };
    case 'queued':
    default:
      return { text: '#b8b0a6', border: '#3e3934', badge: '#22201d', surface: '#1a1917', glow: 'rgba(120, 112, 104, .12)' };
  }
}

function bubbleTone(kind: BubbleKind, relation: BubbleRelation): { text: string; border: string; background: string } {
  if (kind === 'order') return { text: '#e8d29c', border: '#80662e', background: '#2a2114' };
  if (kind === 'report') return { text: '#a9d9c1', border: '#3f6b58', background: '#182820' };
  if (kind === 'verdict') return { text: '#f0b29f', border: '#804b3e', background: '#2c1915' };
  return relation === 'peer'
    ? { text: '#b7c5e8', border: '#465879', background: '#171d2b' }
    : { text: '#c7c0b5', border: '#4a433c', background: '#1d1b18' };
}

function relationGlyph(relation: BubbleRelation): string {
  switch (relation) {
    case 'down': return '↓';
    case 'up': return '↑';
    case 'peer': return '↔';
  }
}

function intelTierLabel(tier: ScopedIntelTier): string {
  switch (tier) {
    case 'run-wide': return 'Run-wide';
    case 'role-scoped': return 'Role scoped';
    case 'private': return 'Private';
  }
}

function intelTierClass(tier: ScopedIntelTier): string {
  switch (tier) {
    case 'run-wide': return 'global';
    case 'role-scoped': return 'squad';
    case 'private': return 'unit';
  }
}

function intelTierBackground(tier: ScopedIntelTier): string {
  switch (tier) {
    case 'run-wide': return 'linear-gradient(180deg, rgba(201,150,47,.1), rgba(201,150,47,.02))';
    case 'role-scoped': return 'linear-gradient(180deg, rgba(150,100,40,.07), transparent)';
    case 'private': return 'rgba(120,90,50,.045)';
  }
}

function intelScopeLabel(entry: ScopedIntelEntry): string {
  if (entry.tier === 'run-wide') return 'global';
  if (entry.tier === 'role-scoped') return 'squad';
  return 'unit';
}

function intelTierColor(tier: ScopedIntelTier): string {
  switch (tier) {
    case 'run-wide': return '#c9a86a';
    case 'role-scoped': return '#8fc7a6';
    case 'private': return '#9aa9d8';
  }
}

function Button({ children, onClick, title, disabled }: { children: React.ReactNode; onClick(): void | Promise<void>; title?: string; disabled?: boolean }) {
  return (
    <button className="soft-btn stbtn orchestration-stbtn" type="button" title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function boardIsSettled(board: BoardData): boolean {
  return board.status === 'done' || board.status === 'error' || board.status === 'idle';
}

type OrchestrationApi = Pick<
  BoardPluginApi,
  | 'materializeBoard'
  | 'rollbackMaterializedBoard'
  | 'appendPluginEvent'
  | 'readPluginAggregate'
  | 'updateAggregateRun'
  | 'readAggregateRun'
  | 'writeAggregateContext'
  | 'readAggregateContext'
  | 'sendBoardMessage'
  | 'readBoardMessages'
  | 'upsertGraphProjectionEdge'
  | 'listBoards'
  | 'getBoard'
  | 'listGraphProjectionEdges'
>;

type OrchestrationReadApi = Pick<
  BoardPluginApi,
  | 'readAggregateRun'
  | 'readAggregateContext'
  | 'readBoardMessages'
  | 'listGraphProjectionEdges'
  | 'listBoards'
  | 'getBoard'
>;

export interface OrchestrationRunSnapshot {
  boardIds: string[];
  contextBlocks: ContextBlockLike[];
  messages: BoardMessageLike[];
  projectionEdges: ProjectionEdgeLike[];
}

function roleRecordPayload(parentBoardId: string, boardId: string, state: OrchestrationState): Record<string, unknown> {
  return {
    parentBoardId,
    boardId,
    runId: state.runId,
    role: state.role,
    stage: state.stage,
    ...(state.planId ? { planId: state.planId } : {}),
    ...(state.packageId ? { packageId: state.packageId } : {}),
  };
}

async function recordRoleBoard(api: OrchestrationApi, parentBoardId: string, boardId: string, state: OrchestrationState) {
  const payload = roleRecordPayload(parentBoardId, boardId, state);
  const context = roleContextText(state);
  const run = await api.updateAggregateRun({
    pluginId: ORCHESTRATION_PLUGIN_ID,
    aggregateId: state.runId,
    status: 'running',
    boardIds: [boardId],
    payload,
  });
  assertPluginResult('aggregate run update', run);
  const block = await api.writeAggregateContext({
    pluginId: ORCHESTRATION_PLUGIN_ID,
    aggregateId: state.runId,
    blockId: `role:${boardId}`,
    scope: state.role,
    title: `${roleLabel(state.role)} ${stageLabel(state.stage)}`,
    content: context,
    budget: 4000,
    payload,
  });
  assertPluginResult('aggregate context write', block);
  const message = await api.sendBoardMessage({
    pluginId: ORCHESTRATION_PLUGIN_ID,
    aggregateId: state.runId,
    sourceBoardId: parentBoardId,
    targetBoardId: boardId,
    correlationId: `role:${boardId}`,
    kind: 'role-materialized',
    text: context,
    payload,
  });
  assertPluginResult('board message send', message);
  const edge = api.upsertGraphProjectionEdge({
    pluginId: ORCHESTRATION_PLUGIN_ID,
    overlayKind: 'role-materialized',
    sourceBoardId: parentBoardId,
    targetBoardId: boardId,
    payload,
    label: roleLabel(state.role),
    className: 'orchestration-projection',
  });
  assertPluginResult('graph projection edge upsert', edge);
  const replayedRun = await api.readAggregateRun(ORCHESTRATION_PLUGIN_ID, state.runId);
  assertPluginResult('aggregate run replay', replayedRun);
  if (!replayedRun.snapshot?.boardIds.includes(boardId)) throw new Error('aggregate run replay did not include the materialized board.');
  const replayedContext = await api.readAggregateContext(ORCHESTRATION_PLUGIN_ID, state.runId, state.role);
  assertPluginResult('aggregate context replay', replayedContext);
  if (!replayedContext.blocks?.some((b) => b.blockId === `role:${boardId}`)) throw new Error('aggregate context replay did not include the materialized role block.');
}

function assertPluginResult(label: string, result: { error?: string } | undefined): void {
  if (result?.error) throw new Error(`${label} failed: ${result.error}`);
}

export async function readOrchestrationRunViewModel(
  api: OrchestrationReadApi,
  boardId: string,
  board: BoardData,
  state: OrchestrationState,
): Promise<RunViewModel | undefined> {
  const snapshot = await readOrchestrationRunSnapshot(api, state);
  return buildOrchestrationRunViewModelFromSnapshot(api, boardId, board, state, snapshot);
}

export async function readOrchestrationRunSnapshot(
  api: OrchestrationReadApi,
  state: Pick<OrchestrationState, 'runId'>,
): Promise<OrchestrationRunSnapshot> {
  const [run, context, messages] = await Promise.all([
    api.readAggregateRun(ORCHESTRATION_PLUGIN_ID, state.runId),
    api.readAggregateContext(ORCHESTRATION_PLUGIN_ID, state.runId),
    api.readBoardMessages(ORCHESTRATION_PLUGIN_ID, state.runId),
  ]);
  assertPluginResult('aggregate run read', run);
  assertPluginResult('aggregate context read', context);
  assertPluginResult('board messages read', messages);

  return {
    boardIds: run.snapshot?.boardIds ?? [],
    contextBlocks: context.blocks ?? [],
    messages: messages.messages ?? [],
    projectionEdges: api.listGraphProjectionEdges?.(ORCHESTRATION_PLUGIN_ID) ?? [],
  };
}

export function buildOrchestrationRunViewModelFromSnapshot(
  api: Pick<OrchestrationReadApi, 'listBoards' | 'getBoard'>,
  boardId: string,
  board: BoardData,
  state: OrchestrationState,
  snapshot: OrchestrationRunSnapshot,
): RunViewModel | undefined {
  const listed = new Map((api.listBoards?.() ?? []).map((entry) => [entry.boardId, entry.board]));
  const boardIds = new Set<string>(snapshot.boardIds);
  boardIds.add(boardId);
  for (const entry of listed) {
    const entryState = asOrchestrationState(entry[1].elements?.[ORCHESTRATION_PLUGIN_ID]);
    if (entryState?.runId === state.runId) boardIds.add(entry[0]);
  }
  const boards = [...boardIds].flatMap((id) => {
    const data = id === boardId ? board : api.getBoard?.(id) ?? listed.get(id);
    return data ? [{ boardId: id, board: data }] : [];
  });
  const model = buildRunViewModel({
    runId: state.runId,
    focusedBoardId: boardId,
    boards,
    contextBlocks: snapshot.contextBlocks,
    messages: snapshot.messages,
    projectionEdges: snapshot.projectionEdges,
  });
  return model.cards.length ? model : undefined;
}

export async function materializeOrchestrationRoleBoard(
  api: OrchestrationApi,
  parentBoardId: string,
  state: OrchestrationState,
  prompt: string,
): Promise<string | undefined> {
  const result = await api.materializeBoard({
    parentBoardId,
    select: true,
    prompt,
    rollbackOnStartFailure: true,
    data: {
      elements: {
        [ORCHESTRATION_PLUGIN_ID]: state,
      },
    },
  });
  const id = result.boardId;
  if (!id) return undefined;
  try {
    await recordRoleBoard(api, parentBoardId, id, state);
  } catch (err) {
    api.rollbackMaterializedBoard(id);
    throw err;
  }
  return id;
}

export async function materializeManualOrchestrationArchetype(
  api: OrchestrationApi,
  parentBoardId: string,
  board: BoardData,
  state: OrchestrationState,
  archetypeId: OrchestrationArchetypeId,
): Promise<string | undefined> {
  const archetype = archetypeById(archetypeId);
  const roleState = initialOrchestrationState(state.runId, archetype.engineRole, {
    planId: state.planId,
    architectBoardId: state.architectBoardId ?? (state.role === 'architect' ? parentBoardId : undefined),
    leadBoardId: state.leadBoardId ?? (state.role === 'leadEngineer' ? parentBoardId : undefined),
    integrationBoardId: state.integrationBoardId,
    testBoardId: state.testBoardId,
    reviewerBoardId: state.reviewerBoardId,
    workerBoardIds: state.workerBoardIds,
    workPackages: state.workPackages,
    decision: state.decision,
    stage: archetype.defaultStage,
    packageId: `manual:${archetype.id}`,
    packageTitle: archetype.name,
    packageScope: archetype.tagline,
    note: `${archetype.name}: ${archetype.blurb}`,
  });
  return materializeOrchestrationRoleBoard(api, parentBoardId, roleState, manualArchetypePrompt(board, state, archetype));
}

function manualArchetypePrompt(source: BoardData, state: OrchestrationState, archetype: OrchestrationCardArchetype): string {
  const currentAnswer = typeof source.answer === 'string' && source.answer.trim()
    ? source.answer.trim().slice(0, 4000)
    : '(no current answer yet)';
  return [
    `You are ${archetype.name} (${archetype.roleName}) in orchestration run ${state.runId}.`,
    `Engine role: ${roleLabel(archetype.engineRole)}. Stage: ${stageLabel(archetype.defaultStage)}.`,
    `Mission: ${archetype.tagline}. Expected output: ${archetype.produces}.`,
    '',
    'Stay inside this manual card scope. Report blockers instead of expanding the task.',
    '',
    'Parent board prompt:',
    source.prompt || '(no prompt)',
    '',
    'Parent board current answer:',
    currentAnswer,
  ].join('\n');
}

export async function applyOrchestrationDecision(
  api: OrchestrationApi & Pick<BoardPluginApi, 'patchBoard'>,
  boardId: string,
  board: BoardData,
  state: OrchestrationState,
  decision: OrchestrationDecision,
): Promise<void> {
  const planId = safePlanId(decision.planId || state.planId);
  const base: OrchestrationState = {
    ...state,
    planId,
    decision: { ...decision, planId: planId || decision.planId },
    architectBoardId: state.architectBoardId ?? (state.role === 'architect' ? boardId : state.architectBoardId),
  };

  if (decision.route === 'blocked') {
    setState(api, boardId, board, {
      ...base,
      stage: 'blocked',
      note: decision.rationale || 'The orchestrator chose a blocked/no-op route.',
    });
    return;
  }

  if (decision.route === 'single-lead') {
    const leadState = initialOrchestrationState(state.runId, 'leadEngineer', {
      planId,
      architectBoardId: base.architectBoardId ?? boardId,
      decision: base.decision,
      stage: 'execution',
    });
    const leadId = await materializeOrchestrationRoleBoard(api, boardId, leadState, leadPrompt(board, base));
    if (leadId) setState(api, boardId, board, { ...base, leadBoardId: leadId });
    return;
  }

  if (decision.route === 'parallel-workers') {
    const packages = decision.workPackages;
    if (!packages.length) {
      setState(api, boardId, board, {
        ...base,
        stage: 'blocked',
        note: 'Parallel-worker decision did not include explicit work packages.',
      });
      return;
    }
    const workerIds: string[] = [];
    for (const pkg of packages) {
      const workerState = initialOrchestrationState(state.runId, 'workerEngineer', {
        planId,
        architectBoardId: base.architectBoardId ?? boardId,
        leadBoardId: state.leadBoardId,
        decision: base.decision,
        packageId: pkg.id,
        packageTitle: pkg.title,
        packageScope: pkg.scope,
        stage: 'worker',
      });
      const workerId = await materializeOrchestrationRoleBoard(api, boardId, workerState, workerPrompt(board, base, pkg));
      if (workerId) workerIds.push(workerId);
    }
    setState(api, boardId, board, {
      ...base,
      stage: 'execution',
      workPackages: packages,
      workerBoardIds: workerIds,
    });
    return;
  }

  if (decision.route === 'test-gate') {
    const testState = initialOrchestrationState(state.runId, 'testEngineer', {
      planId,
      architectBoardId: base.architectBoardId,
      leadBoardId: state.leadBoardId,
      integrationBoardId: state.integrationBoardId ?? boardId,
      decision: base.decision,
      stage: 'test',
    });
    const testId = await materializeOrchestrationRoleBoard(api, boardId, testState, testPrompt(board, base));
    if (testId) setState(api, boardId, board, { ...base, testBoardId: testId });
    return;
  }

  if (decision.route === 'review') {
    const reviewState = initialOrchestrationState(state.runId, 'reviewer', {
      planId,
      architectBoardId: base.architectBoardId,
      testBoardId: state.testBoardId ?? boardId,
      decision: base.decision,
      stage: 'review',
    });
    const reviewerId = await materializeOrchestrationRoleBoard(api, boardId, reviewState, reviewPrompt(board, base));
    if (reviewerId) setState(api, boardId, board, { ...base, reviewerBoardId: reviewerId });
  }
}

export async function applyRecordedOrchestrationDecision(
  api: OrchestrationApi & Pick<BoardPluginApi, 'patchBoard'>,
  boardId: string,
  board: BoardData,
  state: OrchestrationState,
): Promise<boolean> {
  const decision = await captureDecisionFromBoard(api, boardId, board, state);
  if (!decision) return false;
  await applyOrchestrationDecision(api, boardId, board, state, decision);
  return true;
}

function StartAction({ boardId, board, api }: { boardId: string; board: BoardData; api: any }) {
  return (
    <Button
      title="Create a visible Architect board for this request"
      onClick={async () => {
        const runId = newRunId();
        const state = initialOrchestrationState(runId, 'architect', {
          sourceBoardId: boardId,
          architectBoardId: undefined,
          stage: 'planning',
        });
        const childId = await materializeOrchestrationRoleBoard(api, boardId, { ...state }, architectPrompt(board, runId));
        const child = childId ? api.getBoard?.(childId) : undefined;
        if (childId && child) setState(api, childId, child, { ...state, architectBoardId: childId });
      }}
    >
      Start orchestration
    </Button>
  );
}

function RoleActions({ boardId, board, api, state }: { boardId: string; board: BoardData; api: any; state: OrchestrationState }) {
  if ((state.workerBoardIds ?? []).length && state.stage !== 'integration' && state.role !== 'workerEngineer') {
    return (
      <Button
        title="Create an integration board seeded with worker reports"
        onClick={async () => {
          const reports = await captureWorkerReportsFromBoards(api, state);
          const integrationState = initialOrchestrationState(state.runId, 'leadEngineer', {
            planId: state.planId,
            architectBoardId: state.architectBoardId,
            leadBoardId: state.leadBoardId ?? boardId,
            workerBoardIds: state.workerBoardIds,
            workPackages: state.workPackages,
            decision: state.decision,
            stage: 'integration',
          });
          const integrationId = await materializeOrchestrationRoleBoard(api, boardId, integrationState, integrationPrompt(board, reports, state));
          if (integrationId) setState(api, boardId, board, { ...state, integrationBoardId: integrationId });
        }}
      >
        Integrate workers
      </Button>
    );
  }

  if (state.role === 'architect') {
    return (
      <Button
        disabled={!boardIsSettled(board)}
        title={state.decision ? `Apply ${decisionRouteLabel(state.decision.route)} orchestration decision` : 'Capture and apply the aggregate-recorded orchestration decision'}
        onClick={async () => {
          await applyRecordedOrchestrationDecision(api, boardId, board, state);
        }}
      >
        {state.decision ? `Apply ${decisionRouteLabel(state.decision.route)}` : 'Apply decision'}
      </Button>
    );
  }

  if (state.role === 'leadEngineer' && state.stage !== 'integration' && !(state.workerBoardIds ?? []).length) {
    return (
      <Button
        disabled={!boardIsSettled(board)}
        title="Create visible Worker Engineer boards from the Lead work-package section"
        onClick={async () => {
          const packages = await captureWorkPackagesFromBoard(api, boardId, board, state);
          const workerIds: string[] = [];
          for (const pkg of packages) {
            const workerState = initialOrchestrationState(state.runId, 'workerEngineer', {
              planId: state.planId,
              leadBoardId: boardId,
              packageId: pkg.id,
              packageTitle: pkg.title,
              packageScope: pkg.scope,
              stage: 'worker',
            });
            const workerId = await materializeOrchestrationRoleBoard(api, boardId, workerState, workerPrompt(board, state, pkg));
            if (workerId) workerIds.push(workerId);
          }
          setState(api, boardId, board, { ...state, workPackages: packages, workerBoardIds: workerIds });
        }}
      >
        Spawn workers
      </Button>
    );
  }

  if (state.role === 'leadEngineer' && (state.workerBoardIds ?? []).length) {
    return (
      <Button
        title="Create an integration board seeded with worker reports"
        onClick={async () => {
          const reports = await captureWorkerReportsFromBoards(api, state);
          const integrationState = initialOrchestrationState(state.runId, 'leadEngineer', {
            planId: state.planId,
            leadBoardId: boardId,
            workerBoardIds: state.workerBoardIds,
            workPackages: state.workPackages,
            stage: 'integration',
          });
          const integrationId = await materializeOrchestrationRoleBoard(api, boardId, integrationState, integrationPrompt(board, reports, state));
          if (integrationId) setState(api, boardId, board, { ...state, integrationBoardId: integrationId });
        }}
      >
        Integrate workers
      </Button>
    );
  }

  if (state.role === 'leadEngineer' && state.stage === 'integration') {
    return (
      <Button
        disabled={!boardIsSettled(board)}
        title="Create a visible Test Engineer board"
        onClick={async () => {
          const testState = initialOrchestrationState(state.runId, 'testEngineer', {
            planId: state.planId,
            leadBoardId: state.leadBoardId,
            integrationBoardId: boardId,
            stage: 'test',
          });
          const testId = await materializeOrchestrationRoleBoard(api, boardId, testState, testPrompt(board, state));
          if (testId) setState(api, boardId, board, { ...state, testBoardId: testId });
        }}
      >
        Create test gate
      </Button>
    );
  }

  if (state.role === 'testEngineer') {
    return (
      <>
        <Button
          disabled={!boardIsSettled(board)}
          title="Create a repair Lead Engineer board from this test report"
          onClick={async () => {
            const repairState = initialOrchestrationState(state.runId, 'leadEngineer', {
              planId: state.planId,
              testBoardId: boardId,
              stage: 'repair',
            });
            await materializeOrchestrationRoleBoard(api, boardId, repairState, repairPrompt(board, state));
          }}
        >
          Repair from tests
        </Button>
        <Button
          disabled={!boardIsSettled(board)}
          title="Create a final Reviewer board"
          onClick={async () => {
            const reviewState = initialOrchestrationState(state.runId, 'reviewer', {
              planId: state.planId,
              testBoardId: boardId,
              stage: 'review',
            });
            const reviewerId = await materializeOrchestrationRoleBoard(api, boardId, reviewState, reviewPrompt(board, state));
            if (reviewerId) setState(api, boardId, board, { ...state, reviewerBoardId: reviewerId });
          }}
        >
          Create review
        </Button>
      </>
    );
  }

  if (state.role === 'reviewer') {
    return (
      <Button
        disabled={!boardIsSettled(board)}
        title="Mark this orchestration review as complete"
        onClick={() => setState(api, boardId, board, { ...state, stage: 'complete', completed: true })}
      >
        Mark complete
      </Button>
    );
  }

  return null;
}

export const orchestrationElementPlugin: BoardElementPlugin<OrchestrationConfig> = {
  id: ORCHESTRATION_PLUGIN_ID,
  label: 'Orchestration',
  manifest,
  defaultConfig: {},
  render({ boardId, board, slot, state, api }) {
    const os = asOrchestrationState(state);
    if (!os) return null;
    if (slot === 'card-top') return <RoleChip state={os} />;
    if (slot === 'card-head-inline') return <RoleChip state={os} inline />;
    if (slot === 'chatview-aside') return <OrchestrationRunPanel boardId={boardId} board={board} api={api} state={os} />;
    return null;
  },
  boardMenu({ boardId, board, api }) {
    const cur = stateOf(board);
    const runId = cur?.runId ?? newRunId();
    const items: BoardMenuItem[] = ORCHESTRATION_ROLES.map((role: OrchestrationRole) => ({
      key: `orchestration-role-${role}`,
      label: `Orchestration: mark as ${roleLabel(role)}`,
      title: roleDescription(role),
      onClick: () => setState(api, boardId, board, upsertRole(cur, role, { runId })),
    }));
    if (cur) {
      items.push({
        key: 'orchestration-clear',
        label: 'Orchestration: clear role',
        onClick: () => {
          const { [ORCHESTRATION_PLUGIN_ID]: _drop, ...rest } = board.elements ?? {};
          api.patchBoard(boardId, { elements: rest });
        },
      });
    }
    return items;
  },
  inheritOnFork(parentState) {
    const state = asOrchestrationState(parentState);
    if (!state) return undefined;
    return { ...state, note: undefined };
  },
  searchText(state) {
    const os = asOrchestrationState(state);
    return os ? [
      roleLabel(os.role),
      stageLabel(os.stage),
      os.planId,
      os.packageTitle,
      os.decision ? decisionRouteLabel(os.decision.route) : undefined,
      os.decision?.rationale,
    ].filter(Boolean).join(' ') : undefined;
  },
};

export const orchestrationActionPlugin: BoardActionPlugin<OrchestrationConfig> = {
  id: 'orchestration.actions',
  label: 'Orchestration actions',
  manifest,
  defaultConfig: {},
  render({ boardId, board, api }) {
    if (board.status === 'streaming' || board.status === 'waiting' || board.archived) return null;
    const state = stateOf(board);
    return (
      <div className="plugin-actions plugin-actions--orchestration nodrag nopan">
        {state ? <RoleActions boardId={boardId} board={board} api={api} state={state} /> : <StartAction boardId={boardId} board={board} api={api} />}
      </div>
    );
  },
};

export const orchestrationContextProvider: ContextProviderPlugin<OrchestrationConfig> = {
  id: ORCHESTRATION_PLUGIN_ID,
  label: 'Orchestration',
  manifest,
  defaultConfig: {},
  provide({ board }) {
    const state = stateOf(board);
    return state ? { text: roleContextText(state), budget: 4000 } : null;
  },
};
