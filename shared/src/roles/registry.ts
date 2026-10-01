import { HOOK_NAMES, type RoleDef, type RoleRegistry } from './types';

const roles: RoleRegistry = new Map();

/** 注册角色（重复 id 或非法定义抛错） */
export function registerRole(def: RoleDef): void {
  const errs: string[] = [];
  if (!def || typeof def !== 'object') throw new Error('角色定义必须是对象');
  if (!/^[a-z0-9-]+$/.test(def.id ?? '')) errs.push('id 必须是小写字母、数字、连字符');
  if (roles.has(def.id)) errs.push(`id 重复: ${def.id}`);
  if (!def.name?.trim()) errs.push('缺少角色名');
  if (!Array.isArray(def.skills) || def.skills.length < 1 || def.skills.length > 2)
    errs.push('技能数需为 1-2 个');
  for (const s of def.skills ?? []) {
    if (!/^[a-z0-9-]+$/.test(s?.id ?? '')) errs.push(`技能 id 非法: ${s?.id}`);
    if (!s?.name?.trim()) errs.push(`技能 ${s?.id} 缺少技能名`);
    if (!s?.description?.trim()) errs.push(`技能 ${s?.id} 缺少技能说明`);
  }
  if (def.skillActions) {
    for (const a of def.skillActions) {
      if (!(def.skills ?? []).some((s) => s.id === a.skillId)) errs.push(`技能动作引用了不存在的技能: ${a.skillId}`);
      if (a.when !== 'myTurn' && a.when !== 'following') errs.push(`技能动作时机非法: ${a.when}`);
    }
  }
  if (def.hooks) {
    for (const key of Object.keys(def.hooks)) {
      if (!(HOOK_NAMES as readonly string[]).includes(key)) errs.push(`未知钩子: ${key}`);
    }
  }
  if (def.seatOrder !== undefined) {
    if (!Number.isInteger(def.seatOrder) || def.seatOrder < 1) errs.push('seatOrder 必须是不小于 1 的整数');
    for (const other of roles.values()) {
      if (other.seatOrder === def.seatOrder) errs.push(`seatOrder 重复: ${def.seatOrder}`);
    }
  }
  if (errs.length > 0) throw new Error(`角色定义不合法(${def?.name ?? def?.id ?? '?'}): ${errs.join('; ')}`);
  roles.set(def.id, def);
}

/** 全部角色，按席位顺序（seatOrder 1 = 首席…）；无 seatOrder 的排在最后（稳定排序保注册序） */
export function listRoles(): RoleDef[] {
  return [...roles.values()].sort((a, b) => (a.seatOrder ?? Infinity) - (b.seatOrder ?? Infinity));
}

export function getRole(id: string): RoleDef | undefined {
  return roles.get(id);
}

/** 仅测试用 */
export function clearRoles(): void {
  roles.clear();
}
