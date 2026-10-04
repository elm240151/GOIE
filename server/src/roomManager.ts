// 房间管理：建房/加入/回收（6 位数字房间号），socket → 房间路由。
import type { RoleRegistry, SkillUsePayload } from '@gdys/shared';
import { Room, type RoomOptions, type RoomSocket } from './room';
import type { ScoreStore } from './scoreStore';

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly route = new Map<string, { room: Room; playerId: string }>();
  private readonly roles: RoleRegistry;
  private readonly scoreStore: ScoreStore;
  private readonly autoPassMs: number;
  private readonly engineFactory: RoomOptions['engineFactory'];

  constructor(opts: { roles: RoleRegistry; scoreStore: ScoreStore; autoPassMs?: number; engineFactory?: RoomOptions['engineFactory'] }) {
    this.roles = opts.roles;
    this.scoreStore = opts.scoreStore;
    this.autoPassMs = opts.autoPassMs ?? 30_000;
    this.engineFactory = opts.engineFactory;
  }

  create(name: string, socket: RoomSocket): { code: string; playerId: string; secret: string } {
    const room = new Room({
      code: this.newCode(),
      roles: this.roles,
      scoreStore: this.scoreStore,
      autoPassMs: this.autoPassMs,
      engineFactory: this.engineFactory,
    });
    const seat = room.addPlayer(name, socket, true);
    this.rooms.set(room.code, room);
    this.route.set(socket.id, { room, playerId: seat.playerId });
    room.broadcastState();
    return { code: room.code, playerId: seat.playerId, secret: seat.secret };
  }

  join(code: string, name: string, socket: RoomSocket): { code: string; playerId: string; secret: string } {
    const room = this.rooms.get(String(code ?? '').trim());
    if (!room) throw new Error('房间不存在');
    const seat = room.addPlayer(name, socket, false);
    this.route.set(socket.id, { room, playerId: seat.playerId });
    room.broadcastState();
    return { code: room.code, playerId: seat.playerId, secret: seat.secret };
  }

  rejoin(code: string, playerId: string, secret: string, socket: RoomSocket): void {
    const room = this.rooms.get(String(code ?? '').trim());
    if (!room) throw new Error('房间不存在');
    room.rejoin(playerId, secret, socket);
    this.route.set(socket.id, { room, playerId });
  }

  selectRole(socketId: string, roleId: string): void {
    const { room, playerId } = this.locate(socketId);
    room.selectRole(playerId, roleId);
  }

  setReady(socketId: string, ready: boolean): void {
    const { room, playerId } = this.locate(socketId);
    room.setReady(playerId, ready);
  }

  startGame(socketId: string): void {
    const { room, playerId } = this.locate(socketId);
    room.startGame(playerId);
  }

  play(socketId: string, cardIds: number[], flippedCardId?: number): void {
    const { room, playerId } = this.locate(socketId);
    room.play(playerId, cardIds, flippedCardId);
  }

  pass(socketId: string): void {
    const { room, playerId } = this.locate(socketId);
    room.pass(playerId);
  }

  useSkill(socketId: string, req: SkillUsePayload): void {
    const { room, playerId } = this.locate(socketId);
    room.useSkill(playerId, req);
  }

  rematch(socketId: string): void {
    const { room, playerId } = this.locate(socketId);
    room.rematch(playerId);
  }

  leave(socketId: string): void {
    const hit = this.route.get(socketId);
    if (!hit) return;
    hit.room.leave(socketId);
    this.route.delete(socketId);
    if (hit.room.playerCount === 0) {
      hit.room.clearTimers();
      this.rooms.delete(hit.room.code);
    }
  }

  disconnect(socketId: string): void {
    const hit = this.route.get(socketId);
    if (!hit) return;
    hit.room.onSocketDisconnect(socketId);
    this.route.delete(socketId);
  }

  async listScores() {
    return this.scoreStore.list();
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  private locate(socketId: string): { room: Room; playerId: string } {
    const hit = this.route.get(socketId);
    if (!hit) throw new Error('你还没有加入房间');
    return hit;
  }

  private newCode(): string {
    for (let i = 0; i < 100; i++) {
      const code = String(100000 + Math.floor(Math.random() * 900000));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('房间号生成失败，请重试');
  }
}
