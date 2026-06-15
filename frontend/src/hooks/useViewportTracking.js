import { useEffect, useMemo, useRef, useState } from "react";

export function useViewportTracking(targetRef, options = {}) {
  const [entry, setEntry] = useState(null);
  const observerRef = useRef(null);

  const observerOptions = useMemo(
    () => ({
      root: options.rootRef?.current || options.root || null,
      threshold: options.threshold || [0, 0.25, 0.5, 0.75, 1]
    }),
    [options.root, options.rootRef, options.threshold]
  );

  useEffect(() => {
    const node = targetRef.current;
    if (!node) return undefined;

    observerRef.current = new IntersectionObserver((entries) => {
      setEntry(entries[0]);
    }, observerOptions);

    observerRef.current.observe(node);
    return () => observerRef.current?.disconnect();
  }, [targetRef, observerOptions]);

  return entry;
}
