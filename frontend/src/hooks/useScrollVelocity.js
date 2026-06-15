import { useEffect, useRef, useState } from "react";

export function useScrollVelocity(containerRef) {
  const lastPos = useRef(0);
  const lastTime = useRef(performance.now());
  const [velocity, setVelocity] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handleScroll = () => {
      const now = performance.now();
      const current = container.scrollTop;
      const delta = current - lastPos.current;
      const dt = now - lastTime.current || 1;
      setVelocity(Math.abs(delta / dt));
      lastPos.current = current;
      lastTime.current = now;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerRef]);

  return velocity;
}
