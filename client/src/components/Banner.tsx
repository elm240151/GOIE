// 顶部大事件横幅：终局（金/流局灰）与淘汰（红）。滑入 + 光晕，2.3s 后淡出、2.65s 自消。
import { useEffect, useState } from 'react';
import { useStore } from '../store';

export default function Banner() {
  const banner = useStore((s) => s.banner);
  const dismissBanner = useStore((s) => s.dismissBanner);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!banner) return;
    setClosing(false);
    const t1 = setTimeout(() => setClosing(true), 2300);
    const t2 = setTimeout(() => dismissBanner(), 2650);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [banner, dismissBanner]);

  if (!banner) return null;
  return <div className={`game-banner banner-${banner.kind} ${closing ? 'game-banner-closing' : ''}`}>{banner.text}</div>;
}
