// Socket.IO 事件接线：全部客户端事件 → RoomManager，错误统一回 ack 中文原因。
import type { Server, Socket } from 'socket.io';
import {
  CLIENT_EVENTS,
  type AckResult,
  type PlayPayload,
  type ReadyPayload,
  type RoleSelectPayload,
  type RoomCreateAck,
  type RoomCreatePayload,
  type RoomJoinPayload,
  type RoomRejoinPayload,
  type RoomRemoveBotPayload,
  type ScoreListAck,
  type SkillUsePayload,
} from '@gdys/shared';
import type { RoomManager } from './roomManager';

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerHandlers(io: Server, rooms: RoomManager): void {
  io.on('connection', (socket: Socket) => {
    socket.on(CLIENT_EVENTS.roomCreate, (payload: RoomCreatePayload | undefined, ack?: (res: AckResult<RoomCreateAck>) => void) => {
      try {
        ack?.({ ok: true, ...rooms.create(String(payload?.name ?? ''), socket) });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomJoin, (payload: RoomJoinPayload | undefined, ack?: (res: AckResult<RoomCreateAck>) => void) => {
      try {
        ack?.({ ok: true, ...rooms.join(String(payload?.code ?? ''), String(payload?.name ?? ''), socket) });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomRejoin, (payload: RoomRejoinPayload | undefined, ack?: (res: AckResult) => void) => {
      try {
        rooms.rejoin(String(payload?.code ?? ''), String(payload?.playerId ?? ''), String(payload?.secret ?? ''), socket);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roleSelect, (payload: RoleSelectPayload | undefined, ack?: (res: AckResult) => void) => {
      try {
        rooms.selectRole(socket.id, String(payload?.roleId ?? ''));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomReady, (payload: ReadyPayload | undefined, ack?: (res: AckResult) => void) => {
      try {
        rooms.setReady(socket.id, Boolean(payload?.ready));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomStart, (_payload: unknown, ack?: (res: AckResult) => void) => {
      try {
        rooms.startGame(socket.id);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomRematch, (_payload: unknown, ack?: (res: AckResult) => void) => {
      try {
        rooms.rematch(socket.id);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomAddBot, (_payload: unknown, ack?: (res: AckResult) => void) => {
      try {
        rooms.addBot(socket.id);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomRemoveBot, (payload: RoomRemoveBotPayload | undefined, ack?: (res: AckResult) => void) => {
      try {
        rooms.removeBot(socket.id, String(payload?.playerId ?? ''));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.roomLeave, (_payload: unknown) => {
      rooms.leave(socket.id);
    });

    socket.on(CLIENT_EVENTS.gamePlay, (payload: PlayPayload | undefined, ack?: (res: AckResult) => void) => {
      try {
        const cardIds = Array.isArray(payload?.cardIds) ? payload!.cardIds.map(Number) : [];
        const flippedCardId =
          typeof payload?.flippedCardId === 'number' ? payload.flippedCardId : undefined;
        rooms.play(socket.id, cardIds, flippedCardId);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.gamePass, (_payload: unknown, ack?: (res: AckResult) => void) => {
      try {
        rooms.pass(socket.id);
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.gameUseSkill, (payload: SkillUsePayload | undefined, ack?: (res: AckResult) => void) => {
      try {
        rooms.useSkill(socket.id, {
          askId: payload?.askId,
          skillId: payload?.skillId,
          choice: payload?.choice,
          cardIds: Array.isArray(payload?.cardIds) ? payload!.cardIds.map(Number) : undefined,
          targetPlayerId: payload?.targetPlayerId,
          guess: payload?.guess,
        });
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on(CLIENT_EVENTS.scoreList, async (_payload: unknown, ack?: (res: AckResult<ScoreListAck>) => void) => {
      try {
        ack?.({ ok: true, records: await rooms.listScores() });
      } catch (e) {
        ack?.({ ok: false, error: messageOf(e) });
      }
    });

    socket.on('disconnect', () => {
      rooms.disconnect(socket.id);
    });
  });
}
