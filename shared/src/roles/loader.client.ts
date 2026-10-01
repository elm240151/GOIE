// 前端角色自动发现：Vite import.meta.glob 在构建期预打包全部角色文件（加角色 = 丢一个文件，零其他改动）。
// 注意：此文件只供浏览器使用，勿从 index.ts 导出以免把 import.meta.glob 带进 Node。
import { getRole, registerRole } from './registry';
import type { RoleDef } from './types';

const modules = import.meta.glob<{ default?: RoleDef }>(
  ['./*.ts', '!./loader.*.ts', '!./types.ts', '!./registry.ts', '!./*.test.ts', '!./*.d.ts'],
  { eager: true }
);

/** 注册全部角色（幂等） */
export function loadAllRolesClient(): void {
  for (const path of Object.keys(modules).sort()) {
    const def = modules[path]!.default;
    if (!def) continue;
    if (getRole(def.id)) continue;
    registerRole(def);
  }
}
