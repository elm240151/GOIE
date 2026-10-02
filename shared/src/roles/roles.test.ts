import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import type { GameEvent } from '../engine/events';
import { mulberry32 } from '../engine/rng';
import { loadAllRoles, loadRolesFromDir } from './loader.node';
import { loadAllRolesClient } from './loader.client';
import { clearRoles, getRole, listRoles, registerRole } from './registry';
import type { RoleDef, RoleRegistry } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);

/** 构造指定手牌/角色的引擎并开局 */
function mkEngine(hands: Record<string, Card[]>, roles: Record<string, RoleDef>, startPlayerId = 'p0') {
  const players: EnginePlayer[] = Object.keys(hands).map((id, i) => ({
    id,
    name: `玩家${i}`,
    roleId: roles[id]?.id ?? '',
  }));
  const registry: RoleRegistry = new Map(Object.values(roles).map((r) => [r.id, r]));
  const engine = new GameEngine(defaultRules, players, {
    rng: mulberry32(1),
    startPlayerId,
    roles: registry,
    handsOverride: hands,
  });
  engine.start();
  return engine;
}

/** 全部 9 个角色 id（loader 按文件名排序注册） */
const ROLE_IDS = ['captain', 'cs-champion', 'elm-yao', 'flashpoint', 'patrick', 'skywalker', 'unhumanity', 'yy-xue', 'zecheng'];

describe('角色注册表', () => {
  it('合法定义注册成功，非法定义被拒绝', () => {
    clearRoles();
    registerRole({ id: 'ok-role', name: '好角色', skills: [{ id: 'jineng', name: '技能', description: '说明' }] });
    expect(getRole('ok-role')!.name).toBe('好角色');
    expect(listRoles()).toHaveLength(1);
    // id 不是 kebab-case
    expect(() =>
      registerRole({ id: 'Bad Id!', name: 'x', skills: [{ id: 'y', name: 'y', description: 'z' }] } as unknown as RoleDef)
    ).toThrow('小写');
    // id 重复
    expect(() =>
      registerRole({ id: 'ok-role', name: 'x', skills: [{ id: 'y', name: 'y', description: 'z' }] })
    ).toThrow('重复');
    // 缺技能说明
    expect(() =>
      registerRole({ id: 'no-desc', name: 'x', skills: [{ id: 'y', name: 'y', description: '' }] } as unknown as RoleDef)
    ).toThrow('技能说明');
    // 未知钩子名
    expect(() =>
      registerRole({
        id: 'bad-hook',
        name: 'x',
        skills: [{ id: 'y', name: 'y', description: 'z' }],
        hooks: { notAHook: () => undefined },
      } as unknown as RoleDef)
    ).toThrow('未知钩子');
  });
});

describe('席位排序（seatOrder）', () => {
  // 前 8 席按 seatOrder 排列；captain 起的新角色不带席位前缀、无 seatOrder，按注册序排在后面
  const SEAT_ORDER_IDS = ['skywalker', 'elm-yao', 'unhumanity', 'flashpoint', 'yy-xue', 'cs-champion', 'patrick', 'zecheng', 'captain'];

  it('listRoles 按席位顺序（首席 → 末席）排列', async () => {
    clearRoles();
    await loadAllRoles();
    expect(listRoles().map((r) => r.id)).toEqual(SEAT_ORDER_IDS);
  });

  it('缺 seatOrder 的角色排在已编号角色之后（稳定排序保注册序）', () => {
    clearRoles();
    registerRole({ id: 'a-none', name: '无名次A', skills: [{ id: 'sa', name: '技A', description: 'd' }] });
    registerRole({ id: 'b-seat', seatOrder: 2, name: '次席B', skills: [{ id: 'sb', name: '技B', description: 'd' }] });
    registerRole({ id: 'c-seat', seatOrder: 1, name: '首席C', skills: [{ id: 'sc', name: '技C', description: 'd' }] });
    registerRole({ id: 'd-none', name: '无名次D', skills: [{ id: 'sd', name: '技D', description: 'd' }] });
    expect(listRoles().map((r) => r.id)).toEqual(['c-seat', 'b-seat', 'a-none', 'd-none']);
  });

  it('seatOrder 非法或重复被拒绝', () => {
    clearRoles();
    expect(() =>
      registerRole({ id: 'bad-0', seatOrder: 0, name: 'x', skills: [{ id: 'y0', name: 'y', description: 'z' }] })
    ).toThrow('不小于 1');
    registerRole({ id: 'ok-1', seatOrder: 1, name: 'x', skills: [{ id: 'y1', name: 'y', description: 'z' }] });
    expect(() =>
      registerRole({ id: 'bad-dup', seatOrder: 1, name: 'x', skills: [{ id: 'y2', name: 'y', description: 'z' }] })
    ).toThrow('重复');
  });
});

describe('技能优先原则', () => {
  it('基础规则合法的出牌可以被技能否决', () => {
    const veto3: RoleDef = {
      id: 'test-veto',
      name: '否决者',
      skills: [{ id: 'fou-jue', name: '否决', description: '测试用：否决单3' }],
      hooks: {
        beforePlay(ctx, proposed) {
          if (
            ctx.game.turnPlayerId() === ctx.self.id &&
            proposed.combo.type === 'single' &&
            proposed.combo.rank === 3
          ) {
            return { ok: false, reason: '【否决】不能出单3' };
          }
        },
      },
    };
    const hands = {
      p0: [byRank(3, 1)[0]!, ...byRank(9, 4)],
      p1: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: veto3 });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 起单3 本身合法
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('否决');
  });

  it('同钩子多角色按 priority 降序执行（技能播报顺序）', () => {
    const mkAnnouncer = (id: string, priority: number): RoleDef => ({
      id,
      name: id,
      skills: [{ id: 'bo-bao', name: '播报', description: '测试用：记录钩子执行顺序' }],
      priority,
      hooks: {
        beforePlay(ctx) {
          ctx.game.announce(id, 'ping', `order:${id}`);
        },
      },
    });
    const hands = {
      p0: [byRank(3, 1)[0]!, ...byRank(9, 4)],
      p1: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: mkAnnouncer('order-a', 10), p1: mkAnnouncer('order-b', 5) });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(r.ok).toBe(true);
    const events = (r as { events: GameEvent[] }).events;
    const anns = events.filter((e) => e.type === 'skill:triggered').map((e) => e.text);
    expect(anns).toEqual(['order:order-a', 'order:order-b']);
  });
});

describe('角色加载器', () => {
  it('node loader：默认目录自动发现全部 9 个初始角色（幂等）', async () => {
    clearRoles();
    expect(await loadAllRoles()).toEqual(ROLE_IDS);
    expect(listRoles()).toHaveLength(9);
    expect(await loadAllRoles()).toEqual([]); // 重复加载不重复注册
  });

  it('新增角色 = 丢一个文件，零其他改动', async () => {
    clearRoles();
    const dir = mkdtempSync(join(tmpdir(), 'gdys-roles-'));
    writeFileSync(
      join(dir, 'xie-tian-jun.ts'),
      `const def = {
  id: 'xie-tian-jun',
  name: '谢天君',
  skills: [{ id: 'lei-fa', name: '雷罚', description: '测试角色：丢文件即注册' }],
};
export default def;
`
    );
    const ids = await loadRolesFromDir(pathToFileURL(`${dir}/`));
    expect(ids).toContain('xie-tian-jun');
    expect(getRole('xie-tian-jun')!.name).toBe('谢天君');
    rmSync(dir, { recursive: true, force: true });
  });

  it('client loader：import.meta.glob 自动发现（vitest 环境）', () => {
    clearRoles();
    loadAllRolesClient();
    expect(listRoles().map((r) => r.id).sort()).toEqual(ROLE_IDS);
    loadAllRolesClient(); // 幂等
    expect(listRoles()).toHaveLength(9);
  });
});
