import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import FeedCard from "./FeedCard.jsx";
import { useScrollVelocity } from "../hooks/useScrollVelocity.js";

export default function Feed({ items, onComplete, logger, participantId }) {
  const feedRef = useRef(null);
  const velocity = useScrollVelocity(feedRef);
  const [exposureSummary, setExposureSummary] = useState({});

  useEffect(() => {
    logger.logEvent("feed_start", { totalItems: items.length });
  }, [items.length, logger]);

  // Ensure every card is present in exposureSummary from the start
  useEffect(() => {
    setExposureSummary((prev) => {
      const next = { ...prev };
      items.forEach((item) => {
        if (!next[item.id]) next[item.id] = {};
      });
      return next;
    });
  }, [items]);

  const handleExposureUpdate = (id, update) => {
    setExposureSummary((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...update }
    }));
  };

  const completionReady = useMemo(
    () => Object.keys(exposureSummary).length === items.length,
    [exposureSummary, items.length]
  );

  const handleComplete = () => {
    logger.logEvent("feed_complete", {
      exposureSummary,
      totalItems: items.length
    });
    onComplete(exposureSummary);
  };

  return (
    <section className="mx-auto flex h-[78vh] w-full max-w-5xl flex-col rounded-2xl bg-glass p-6 text-ink shadow-card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-neutral-500">
            Live Feed
          </p>
          <h2 className="text-2xl font-semibold">Explore the feed naturally</h2>
        </div>
        <div className="rounded-full border border-neutral-200 bg-white/80 px-4 py-2 text-xs text-neutral-500">
          Scroll freely. Interact if you want.
        </div>
      </div>
      <div
        ref={feedRef}
        className="feed-scrollbar feed-shell flex-1 overflow-y-auto rounded-2xl p-4"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-6">
          {items.map((item) => (
            <FeedCard
              key={item.id}
              item={item}
              logger={logger}
              participantId={participantId}
              scrollVelocity={velocity}
              onExposureUpdate={handleExposureUpdate}
              rootRef={feedRef}
            />
          ))}
          <div className="mt-4 flex justify-center">
            <motion.button
              whileTap={{ scale: 0.98 }}
              disabled={!completionReady}
              onClick={handleComplete}
              className={`rounded-full px-6 py-3 text-sm font-semibold transition ${
                completionReady
                  ? "bg-ink text-fog"
                  : "bg-neutral-200 text-neutral-400"
              }`}
            >
              Continue
            </motion.button>
          </div>
        </div>
      </div>
    </section>
  );
}
