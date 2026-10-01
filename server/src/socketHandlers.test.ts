import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRoles,
  listRoles,
  CLIENT_EVENTS,
  SERVER_EVENTS,
  type AckResult,
  type RoleRegistry,
  type RoomCreateAck,
} from '@gdys/shared';
import { loadAllRoles } from '@gdys/shared/roles/loader.node';
import type { Server } from 'socket.io';
import { RoomManager } from './roomManager';
import { MemoryScoreStore } from './scoreStore';
import { registerHandlers } from './socketHandlers';

type Handler = (payload: unknown, ack?: (res: unknown) => void) => void;

beforeEach(async () => {
  clearRoles();
  await loadAllRoles();
});

/** 同一套假 io + RoomManager 上的多个假 socket，捕获处理器与发出的消息 */
function harness() {
  const conns: Array<(s: unknown) => void> = [];
  const io = {
    on: vi.fn((ev: string, fn: unknown) => {
      if (ev === 'connection') conns.push(fn as (s: unknown) => void);
    }),
  } as unknown as Server;
  const roles: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  registerHandlers(io, new RoomManager({ roles, scoreStore: new MemoryScoreStore() }));
  let n = 0;
  const connect = (): { handlers: Record<string, Handler>; emits: Array<[string, unknown]> } => {
    const handlers: Record<string, Handler> = {};
    const emits: Array<[string, unknown]> = [];
    const socket = {
      id: `sock-${n++}`,
      emit: vi.fn((ev: string, data: unknown) => {
        emits.push([ev, data]);
      }),
      on: vi.fn((ev: string, fn: unknown) => {
        handlers[ev] = fn as Handler;
      }),
    };
    conns[0]!(socket);
    return { handlers, emits };
  };
  return { connect };
}

function call(handler: Handler, payload: unknown): Promise<AckResult<RoomCreateAck>> {
  return new Promise((resolve) => handler(payload, (r) => resolve(r as AckResult<RoomCreateAck>)));
}

describe('socketHandlers', () => {
  it('建房/加入走通并广播，错误回执带中文原因', async () => {
    const { connect } = harness();
    const a = connect();
    const created = await call(a.handlers[CLIENT_EVENTS.roomCreate]!, { name: '测试员' });
    expect(created.ok).toBe(true);
    const code = (created as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);
    expect(a.emits.some(([ev]) => ev === SERVER_EVENTS.roomUpdated)).toBe(true);

    const b = connect();
    const joined = await call(b.handlers[CLIENT_EVENTS.roomJoin]!, { code, name: '二号' });
    expect(joined.ok).toBe(true);

    const c = connect();
    const bad = await call(c.handlers[CLIENT_EVENTS.roomJoin]!, { code: '000000', name: '三号' });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toContain('房间不存在');

    // 断线清理
    a.handlers['disconnect']!(undefined);
    b.handlers['disconnect']!(undefined);
    c.handlers['disconnect']!(undefined);
  });
});
