import { describe, expect, it } from 'vitest';
import type { BoardLike } from '../shared/board';
import { lessonRecordingGap, mentionsLessonRecording, recordedToVaultThisTurn } from './detect';

function board(p: Partial<BoardLike>): BoardLike {
  return { status: 'done', ...p };
}

describe('mentionsLessonRecording', () => {
  it('fires on Chinese 记下 / 教训 recording claims', () => {
    expect(mentionsLessonRecording('我记下了这几条教训：先核对世界名')).toBe(true);
    expect(mentionsLessonRecording('总结的几条教训如下')).toBe(true);
  });

  it('fires on English lessons-learned and capture-verb-near-knowledge-noun', () => {
    expect(mentionsLessonRecording('Here are the lessons learned from this run.')).toBe(true);
    expect(mentionsLessonRecording("I'll record these gotchas for next time.")).toBe(true);
    expect(mentionsLessonRecording('Let me capture this finding in the vault.')).toBe(true);
  });

  it('does not fire on benign conversational text', () => {
    expect(mentionsLessonRecording('Let me check the build output.')).toBe(false);
    expect(mentionsLessonRecording('The file was saved successfully.')).toBe(false);
    expect(mentionsLessonRecording('I noted the test passed.')).toBe(false); // "note" without a knowledge noun
  });
});

describe('recordedToVaultThisTurn', () => {
  it('true when a Write targets .braid/knowledge/', () => {
    expect(
      recordedToVaultThisTurn(board({ steps: [{ id: '1', name: 'Write', input: { file_path: 'D:/proj/.braid/knowledge/x.md' } }] })),
    ).toBe(true);
  });

  it('true for a Codex fileChange under the vault', () => {
    expect(
      recordedToVaultThisTurn(board({ steps: [{ id: '1', name: 'fileChange', input: { changes: [{ path: '.braid/knowledge/y.md' }] } }] })),
    ).toBe(true);
  });

  it('false for a write outside the vault', () => {
    expect(recordedToVaultThisTurn(board({ steps: [{ id: '1', name: 'Write', input: { file_path: 'src/foo.ts' } }] }))).toBe(false);
  });

  it('does NOT count the legacy .braid/knowledge-vault/ directory', () => {
    expect(
      recordedToVaultThisTurn(board({ steps: [{ id: '1', name: 'Write', input: { file_path: '.braid/knowledge-vault/z.md' } }] })),
    ).toBe(false);
  });

  it('reads the latest turn steps on a multi-turn board', () => {
    expect(
      recordedToVaultThisTurn(
        board({
          turns: [
            { answer: 'a', steps: [{ id: '1', name: 'Read', input: {} }] },
            { answer: 'b', steps: [{ id: '2', name: 'Write', input: { file_path: '.braid/knowledge/m.md' } }] },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('lessonRecordingGap', () => {
  it('fires when a settled answer claims a lesson but no vault write happened', () => {
    expect(
      lessonRecordingGap(board({ answer: '我记下了三条教训', steps: [{ id: '1', name: 'Bash', input: { command: 'echo done' } }] })),
    ).toBe(true);
  });

  it('does not fire when the lesson was written to the vault this turn', () => {
    expect(
      lessonRecordingGap(board({ answer: '我记下了三条教训', steps: [{ id: '1', name: 'Write', input: { file_path: '.braid/knowledge/lessons.md' } }] })),
    ).toBe(false);
  });

  it('does not fire when the answer has no lesson claim', () => {
    expect(lessonRecordingGap(board({ answer: 'The build passed.', steps: [] }))).toBe(false);
  });

  it('does not fire while the board is still streaming', () => {
    expect(lessonRecordingGap(board({ status: 'streaming', answer: '我记下了三条教训', steps: [] }))).toBe(false);
  });
});
