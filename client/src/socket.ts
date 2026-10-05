// Socket.IO 单例：全站共享一个连接（dev 走 Vite 代理，prod 同源）。
import { io, type Socket } from 'socket.io-client';
import type { AckResult } from '@gdys/shared';
import { STR } from './strings';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ autoConnect: true });
  }
  return socket;
}

/** 发请求并等 ack 回执（超时 8s 抛错） */
export function emitAck<T extends object = Record<string, unknown>>(ev: string, payload?: unknown): Promise<AckResult<T>> {
  return new Promise((resolve, reject) => {
    getSocket()
      .timeout(8000)
      .emit(ev, payload, (err: unknown, res: AckResult<T>) => {
        if (err) reject(new Error(STR.common.requestTimeout));
        else resolve(res);
      });
  });
}
