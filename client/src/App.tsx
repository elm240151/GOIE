import { useEffect } from 'react';
import { useStore } from './store';
import Lobby from './screens/Lobby';
import Room from './screens/Room';
import GameTable from './screens/GameTable';
import Scoreboard from './screens/Scoreboard';

export default function App() {
  const screen = useStore((s) => s.screen);
  const init = useStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="app">
      {screen === 'lobby' && <Lobby />}
      {screen === 'room' && <Room />}
      {screen === 'game' && <GameTable />}
      {screen === 'scoreboard' && <Scoreboard />}
    </div>
  );
}
