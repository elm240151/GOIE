// 服务端角色自动发现：读取本目录下全部角色文件并注册（加角色 = 丢一个文件，零其他改动）。
// 注意：此文件只供 Node 使用（fs 依赖），勿从 index.ts 导出以免打进前端包。
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getRole, registerRole } from './registry';
import type { RoleDef } from './types';

/** 基础设施文件（不是角色定义），按文件名过滤 */
const INFRA = /^(types|registry|index)\.ts$|^loader\.|\.test\.ts$|\.d\.ts$/;

/** 从指定目录加载全部角色文件，返回本次新注册的角色 id 列表 */
export async function loadRolesFromDir(dirUrl: URL): Promise<string[]> {
  const names = (await readdir(fileURLToPath(dirUrl))).filter((f) => f.endsWith('.ts') && !INFRA.test(f)).sort();
  const ids: string[] = [];
  for (const name of names) {
    const mod = (await import(new URL(name, dirUrl).href)) as { default?: RoleDef };
    const def = mod.default;
    if (!def) continue;
    if (getRole(def.id)) continue; // 幂等：重复加载不重复注册
    registerRole(def);
    ids.push(def.id);
  }
  return ids;
}

/** 加载默认目录（本文件所在目录）里的全部角色文件 */
export function loadAllRoles(): Promise<string[]> {
  return loadRolesFromDir(new URL('.', import.meta.url));
}
