import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameRecord } from '@gdys/shared';
import { JsonFileScoreStore, MemoryScoreStore } from './scoreStore';

const rec: GameRecord = {
  at: '2026-09-26T10:00:00.000Z',
  roomId: '123456',
  winnerId: 'p0',
  players: [
    { id: 'p0', name: 'A', roleId: 'skywalker', score: 2 },
    { id: 'p1', name: 'B', roleId: 'elm-yao', score: -1 },
  ],
};

describe('ScoreStore', () => {
  it('内存实现：增查', async () => {
    const store = new MemoryScoreStore();
    expect(await store.list()).toEqual([]);
    await store.add(rec);
    expect(await store.list()).toEqual([rec]);
  });

  it('JSON 文件实现：读写落盘，文件缺失当空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gdys-scores-'));
    try {
      const store = new JsonFileScoreStore(join(dir, 'scores.json'));
      expect(await store.list()).toEqual([]); // 不存在 → 空
      await store.add(rec);
      expect(await store.list()).toEqual([rec]);
      expect(readFileSync(join(dir, 'scores.json'), 'utf8')).toContain('123456');
      await store.add({ ...rec, roomId: '654321' });
      expect(await store.list()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
