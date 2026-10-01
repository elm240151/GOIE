// 战绩存储：接口 + 内存实现（测试）+ JSON 文件实现（server/data/scores.json，云端可换 Postgres）。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GameRecord } from '@gdys/shared';

export interface ScoreStore {
  add(rec: GameRecord): Promise<void>;
  list(): Promise<GameRecord[]>;
}

/** 测试用内存实现 */
export class MemoryScoreStore implements ScoreStore {
  private readonly records: GameRecord[] = [];

  async add(rec: GameRecord): Promise<void> {
    this.records.push(rec);
  }

  async list(): Promise<GameRecord[]> {
    return [...this.records];
  }
}

/** 落盘 JSON 文件；文件不存在或损坏当作空（战绩丢失优于服务崩溃） */
export class JsonFileScoreStore implements ScoreStore {
  constructor(private readonly file: string) {}

  async add(rec: GameRecord): Promise<void> {
    const all = await this.list();
    all.push(rec);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  async list(): Promise<GameRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(parsed) ? (parsed as GameRecord[]) : [];
    } catch {
      return [];
    }
  }
}
