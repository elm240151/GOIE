// 战绩页：服务端落盘的每局记录。
import { useEffect } from 'react';
import { useStore } from '../store';
import { STR } from '../strings';

export default function Scoreboard() {
  const records = useStore((s) => s.records);
  const fetchScores = useStore((s) => s.fetchScores);
  const setScreen = useStore((s) => s.setScreen);

  useEffect(() => {
    void fetchScores();
  }, [fetchScores]);

  return (
    <div className="screen scoreboard">
      <header className="room-header">
        <button className="btn btn-ghost" onClick={() => setScreen('lobby')}>
          {STR.scoreboard.back}
        </button>
        <h1 className="sb-title">{STR.scoreboard.title}</h1>
      </header>
      {records === null ? (
        <p className="sb-empty">…</p>
      ) : records.length === 0 ? (
        <p className="sb-empty">{STR.scoreboard.empty}</p>
      ) : (
        <ul className="sb-list">
          {records.map((r, i) => {
            const winner = r.players.find((p) => p.id === r.winnerId);
            const d = new Date(r.at);
            return (
              <li key={i} className="sb-record">
                <div className="sb-head">
                  <span className="sb-time">
                    {`${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
                      d.getMinutes()
                    ).padStart(2, '0')}`}
                  </span>
                  <span className="sb-room">{STR.scoreboard.room} {r.roomId}</span>
                  <span className={winner ? 'sb-winner' : 'sb-draw'}>
                    {winner ? `${STR.scoreboard.winner}: ${winner.name}` : STR.scoreboard.draw}
                  </span>
                </div>
                <div className="sb-players">
                  {r.players.map((p) => (
                    <span key={p.id} className={`sb-player ${p.id === r.winnerId ? 'sb-player-win' : ''}`}>
                      {p.name} <em>{p.score > 0 ? `+${p.score}` : p.score}</em>
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
