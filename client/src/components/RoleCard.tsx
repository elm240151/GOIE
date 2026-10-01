// 角色卡片：名字、技能名、技能说明；已被选/已选状态。
import type { RoleDef } from '@gdys/shared';
import { STR } from '../strings';

interface Props {
  def: RoleDef;
  /** 选了该角色的玩家名（null = 可选） */
  takenBy: string | null;
  mine: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export default function RoleCard({ def, takenBy, mine, disabled, onSelect }: Props) {
  return (
    <button
      type="button"
      className={`role-card ${mine ? 'role-mine' : ''} ${takenBy ? 'role-taken' : ''}`}
      disabled={disabled || takenBy !== null}
      onClick={onSelect}
    >
      <div className="role-name">{def.name}</div>
      {def.skills.map((s) => (
        <div key={s.id} className="role-skill-block">
          <div className="role-skill">【{s.name}】{s.locked ? STR.room.lockedSkill : ''}</div>
          <div className="role-desc">{s.description}</div>
        </div>
      ))}
      <div className="role-status">
        {takenBy ? STR.room.roleTaken.replace('{name}', takenBy) : mine ? STR.room.roleYours : ''}
      </div>
    </button>
  );
}
