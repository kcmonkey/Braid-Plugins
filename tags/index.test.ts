import { describe, expect, it } from 'vitest';
import { defaultTagConfig, tagDeriveKey, tagPlugin } from './index';
import type { BoardLike } from '../shared/board';

const doneBoard = (patch: Partial<BoardLike> = {}): BoardLike => ({
  prompt: 'How should summary costs be reduced?',
  answer: 'Combine board summaries with LLM tags and keep fallback routing explicit.',
  status: 'done',
  ...patch,
});

describe('tags plugin summary derivation contribution', () => {
  it('uses the same plugin-owned derive key for standalone and bundled derivation', () => {
    const board = doneBoard();
    const req = tagPlugin.contributeSummaryDerivation?.({
      board,
      config: defaultTagConfig,
      state: undefined,
      activeProvider: 'deepseek',
      providerCaps: {},
    });

    expect(req?.key).toBe(tagDeriveKey(board, defaultTagConfig));
    expect(req?.system).toContain('conversation tagger');
    expect(req?.content).toContain('Q: How should summary costs be reduced?');
  });

  it('stamps bundled output with the current derive key so standalone derivation is satisfied', () => {
    const board = doneBoard();
    const key = tagDeriveKey(board, defaultTagConfig);
    const state = tagPlugin.applySummaryDerivation?.(undefined, 'plan, test', defaultTagConfig, key);

    expect(state).toEqual({ tags: ['plan', 'test'], revision: key });
    expect(tagPlugin.derive({
      board,
      config: defaultTagConfig,
      state,
      activeProvider: 'deepseek',
      providerCaps: {},
    })).toBeNull();
  });

  it('defaults standalone LLM derivation to the summary route unless a provider is explicitly configured', () => {
    const board = doneBoard();

    expect(tagPlugin.derive({
      board,
      config: defaultTagConfig,
      state: undefined,
      activeProvider: 'deepseek',
      providerCaps: {},
    })?.route).toBe('summary');

    expect(tagPlugin.derive({
      board,
      config: { ...defaultTagConfig, engine: 'deepseek', model: 'deepseek-chat' },
      state: undefined,
      activeProvider: 'claude',
      providerCaps: {},
    })).toMatchObject({ route: 'active', engine: 'deepseek', model: 'deepseek-chat' });
  });

  it('does not bundle summary derivation when a custom provider or model is configured', () => {
    const board = doneBoard();

    expect(tagPlugin.contributeSummaryDerivation?.({
      board,
      config: { ...defaultTagConfig, engine: 'deepseek' },
      state: undefined,
      activeProvider: 'claude',
      providerCaps: {},
    })).toBeNull();
    expect(tagPlugin.contributeSummaryDerivation?.({
      board,
      config: { ...defaultTagConfig, model: 'summary-model' },
      state: undefined,
      activeProvider: 'claude',
      providerCaps: {},
    })).toBeNull();
    expect(tagPlugin.derive({
      board,
      config: { ...defaultTagConfig, engine: 'deepseek', model: 'deepseek-chat' },
      state: undefined,
      activeProvider: 'claude',
      providerCaps: {},
    })).toMatchObject({ route: 'active', engine: 'deepseek', model: 'deepseek-chat' });
  });

  it('uses standalone derivation when only the tag vocabulary key is stale', () => {
    const board = doneBoard();
    const oldState = tagPlugin.applySummaryDerivation?.(
      undefined,
      'plan',
      defaultTagConfig,
      tagDeriveKey(board, defaultTagConfig),
    );
    const changedConfig = {
      ...defaultTagConfig,
      tags: [
        ...defaultTagConfig.tags,
        { name: 'cost', color: '#42b883', description: 'cost control and usage reduction' },
      ],
    };

    const req = tagPlugin.derive({
      board,
      config: changedConfig,
      state: oldState,
      activeProvider: 'deepseek',
      providerCaps: {},
    });

    expect(req).toMatchObject({ route: 'summary', key: tagDeriveKey(board, changedConfig) });
  });
});
