// 房间页：大房间号+复制、座位列表、角色选择网格、准备/开始。
import { listRoles } from '@gdys/shared';
import { useStore } from '../store';
import { STR } from '../strings';
import RoleCard from '../components/RoleCard';

export default function Room() {
  const room = useStore((s) => s.room);
  const myId = useStore((s) => s.myId);
  const selectRole = useStore((s) => s.selectRole);
  const setReady = useStore((s) => s.setReady);
  const startGame = useStore((s) => s.startGame);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const toast = useStore((s) => s.toast);

  if (!room) return null;
  const me = room.players.find((p) => p.id === myId);
  const roles = listRoles();
  const allReady = room.players.length >= 2 && room.players.every((p) => p.ready && p.roleId);

  const copyCode = () => {
    void navigator.clipboard.writeText(room.code).then(() => toast('info', STR.room.copied));
  };

  let startHint = '';
  if (me?.isHost) {
    if (room.players.length < 2) startHint = STR.room.startHint.tooFew;
    else if (!allReady) startHint = STR.room.startHint.notAllReady;
  } else {
    startHint = STR.room.startHint.notHost;
  }

  return (
    <div className="screen room">
      <header className="room-header">
        <button className="btn btn-ghost" onClick={leaveRoom}>
          {STR.room.leave}
        </button>
        <button type="button" className="room-code" onClick={copyCode} title={STR.room.copy}>
          {room.code}
          <span className="room-copy-tip">{STR.room.copy}</span>
        </button>
        <span className="room-phase">{room.phase === 'lobby' ? STR.room.waitHost : ''}</span>
      </header>

      <section className="room-seats">
        {room.players.map((p) => (
          <div key={p.id} className={`room-seat ${p.id === myId ? 'room-seat-me' : ''}`}>
            <span className="room-seat-name">
              {p.name}
              {p.isHost && <em className="tag">{STR.room.host}</em>}
              {p.id === myId && <em className="tag">{STR.room.you}</em>}
            </span>
            <span className="room-seat-role">{roles.find((r) => r.id === p.roleId)?.name ?? '未选角色'}</span>
            <span className={`room-seat-ready ${p.ready ? 'ready-on' : ''}`}>
              {p.ready ? STR.room.readyState : '—'}
              {!p.connected && <em className="tag">{STR.room.offlineBadge}</em>}
            </span>
          </div>
        ))}
      </section>

      <section className="room-roles">
        <h2>{STR.room.selectRole}</h2>
        <div className="role-grid">
          {roles.map((def) => (
            <RoleCard
              key={def.id}
              def={def}
              takenBy={room.players.find((p) => p.roleId === def.id)?.name ?? null}
              mine={me?.roleId === def.id}
              disabled={room.phase !== 'lobby'}
              onSelect={() => void selectRole(def.id)}
            />
          ))}
        </div>
      </section>

      <footer className="room-actions">
        <button
          className={`btn btn-big ${me?.ready ? 'btn-secondary' : 'btn-primary'}`}
          disabled={!me?.roleId}
          onClick={() => void setReady(!me?.ready)}
        >
          {!me?.roleId ? STR.room.needRoleFirst : me?.ready ? STR.room.cancelReady : STR.room.ready}
        </button>
        {me?.isHost && (
          <button
            className="btn btn-primary btn-big"
            disabled={room.players.length < 2 || !allReady}
            onClick={() => void startGame()}
          >
            {startHint || STR.room.canStart}
          </button>
        )}
      </footer>
    </div>
  );
}
