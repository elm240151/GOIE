// 大厅：昵称 + 创建/加入房间 + 战绩入口。
import { useState } from 'react';
import { useStore } from '../store';
import { STR } from '../strings';

export default function Lobby() {
  const connected = useStore((s) => s.connected);
  const playerName = useStore((s) => s.playerName);
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const setScreen = useStore((s) => s.setScreen);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const setName = (name: string) => useStore.setState({ playerName: name.slice(0, 12) });
  const canJoin = /^\d{6}$/.test(code) && playerName.trim().length > 0;

  const doCreate = async () => {
    setBusy(true);
    await createRoom();
    setBusy(false);
  };
  const doJoin = async () => {
    if (!canJoin) return;
    setBusy(true);
    await joinRoom(code);
    setBusy(false);
  };

  return (
    <div className="screen lobby">
      <div className="lobby-card">
        <h1 className="lobby-title">{STR.lobby.title}</h1>
        <p className="lobby-subtitle">{STR.lobby.subtitle}</p>
        <label className="field">
          <span>{STR.lobby.nameLabel}</span>
          <input
            value={playerName}
            onChange={(e) => setName(e.target.value)}
            placeholder={STR.lobby.namePlaceholder}
            maxLength={12}
          />
        </label>
        <button className="btn btn-primary btn-big" disabled={busy || !connected || !playerName.trim()} onClick={doCreate}>
          {STR.lobby.create}
        </button>
        <div className="lobby-join">
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={STR.lobby.codePlaceholder}
            inputMode="numeric"
          />
          <button className="btn btn-secondary" disabled={busy || !connected || !canJoin} onClick={doJoin}>
            {STR.lobby.join}
          </button>
        </div>
        <button className="btn btn-ghost btn-big" disabled={busy || !connected} onClick={() => setScreen('scoreboard')}>
          {STR.lobby.scores}
        </button>
        <p className={`lobby-status ${connected ? 'status-on' : 'status-off'}`}>
          {connected ? `● ${STR.lobby.online}` : `○ ${STR.lobby.offline}`}
        </p>
      </div>
    </div>
  );
}
