
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useViewportTracking } from "../hooks/useViewportTracking.js";

// Ensure exposure is registered at least once for this card
// This must come after hooks are imported

const labelPositionMap = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  "bottom-left": "bottom-3 left-3",
  "bottom-right": "bottom-3 right-3"
};

export default function FeedCard({
  item,
  logger,
  scrollVelocity,
  onExposureUpdate,
  rootRef
}) {
  const cardRef = useRef(null);
  const imageRef = useRef(null);
  const labelRef = useRef(null);
  const [imageWidth, setImageWidth] = useState(520);
  const [isVisible, setIsVisible] = useState(false);
  const [fullyVisible, setFullyVisible] = useState(false);
  const [labelSeen, setLabelSeen] = useState(false);
  const [revisitCount, setRevisitCount] = useState(0);
  const revisitRef = useRef(0);
  const enterTimeRef = useRef(null);
  const totalDwellRef = useRef(0);
  const hoverStartRef = useRef(null);
  const hoverTotalRef = useRef(0);
  const pauseStartRef = useRef(null);

  const entry = useViewportTracking(cardRef, {
    rootRef,
    threshold: [0, 0.25, 0.5, 0.75, 1]
  });

  const labelEntry = useViewportTracking(labelRef, {
    rootRef,
    threshold: [0, 1]
  });

  useEffect(() => {
    const node = imageRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entryItem) => {
        if (entryItem.contentRect?.width) {
          setImageWidth(entryItem.contentRect.width);
        }
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!entry) return;
    const ratio = entry.intersectionRatio;
    const now = performance.now();

    if (entry.isIntersecting && !isVisible) {
      setIsVisible(true);
      revisitRef.current += 1;
      setRevisitCount(revisitRef.current);
      enterTimeRef.current = now;
      onExposureUpdate(item.id, {
        totalDwellMs: totalDwellRef.current,
        revisitCount: revisitRef.current,
        hoverTotalMs: hoverTotalRef.current,
        fullyVisible,
        labelSeen
      });
      logger.logEvent("viewport_enter", {
        image_id: item.id,
        ratio,
        timestamp_ms: now,
        attention_check: Boolean(item.attentionCheck)
      });
      if (item.attentionCheck) {
        logger.logEvent("attention_check_seen", { image_id: item.id });
      }
    }

    if (!entry.isIntersecting && isVisible) {
      setIsVisible(false);
      const dwell = now - (enterTimeRef.current || now);
      totalDwellRef.current += dwell;
      logger.logEvent("viewport_exit", {
        image_id: item.id,
        ratio,
        dwell_ms: dwell,
        total_dwell_ms: totalDwellRef.current
      });
      onExposureUpdate(item.id, {
        totalDwellMs: totalDwellRef.current,
        revisitCount: revisitRef.current,
        hoverTotalMs: hoverTotalRef.current,
        fullyVisible,
        labelSeen
      });
    }

    if (ratio >= 1 && !fullyVisible) {
      setFullyVisible(true);
      logger.logEvent("fully_visible", { image_id: item.id, ratio });
    }

    logger.logEvent("visibility_update", {
      image_id: item.id,
      ratio
    });
  }, [entry, fullyVisible, isVisible, item, labelSeen, logger, onExposureUpdate, revisitCount]);

  useEffect(() => {
    if (!labelEntry) return;
    if (labelEntry.isIntersecting && !labelSeen) {
      setLabelSeen(true);
      logger.logEvent("label_enter", { image_id: item.id });
    } else if (!labelEntry.isIntersecting && labelSeen) {
      logger.logEvent("label_exit", { image_id: item.id });
    }
  }, [labelEntry, labelSeen, item.id, logger]);

  useEffect(() => {
    if (!isVisible) return undefined;

    const handlePause = () => {
      const isSlow = scrollVelocity < 0.02;
      if (isSlow && !pauseStartRef.current) {
        pauseStartRef.current = performance.now();
        logger.logEvent("pause_start", { image_id: item.id });
      }
      if (!isSlow && pauseStartRef.current) {
        const duration = performance.now() - pauseStartRef.current;
        logger.logEvent("pause_end", {
          image_id: item.id,
          duration_ms: duration
        });
        pauseStartRef.current = null;
      }
    };

    const interval = setInterval(handlePause, 250);
    return () => clearInterval(interval);
  }, [isVisible, item.id, logger, scrollVelocity]);

  const handleMouseEnter = () => {
    hoverStartRef.current = performance.now();
    logger.logEvent("hover_start", { image_id: item.id });
  };

  const handleMouseLeave = () => {
    const now = performance.now();
    const hoverDuration = now - (hoverStartRef.current || now);
    hoverTotalRef.current += hoverDuration;
    hoverStartRef.current = null;
    logger.logEvent("hover_end", {
      image_id: item.id,
      duration_ms: hoverDuration
    });
  };

  const labelStyle = useMemo(() => {
    if (!item.label) return null;
    const base = Math.max(24, Math.min(56, Math.sqrt(item.label.size) * imageWidth));
    return {
      width: base,
      height: base
    };
  }, [imageWidth, item.label]);

  return (
    <motion.article
      ref={cardRef}
      className="rounded-2xl border border-white/10 bg-white/90 p-4 text-ink shadow-soft"
      whileHover={{ y: -2 }}
    >
      <header className="mb-3 flex items-center gap-3">
        <img
          src={item.avatar}
          alt={item.username}
          className="h-10 w-10 rounded-full border border-white/30"
        />
        <div className="flex-1">
          <p className="text-sm font-semibold">{item.username}</p>
          <p className="text-xs text-neutral-500">{item.timestamp}</p>
        </div>
      </header>
      <div
        ref={imageRef}
        className="relative overflow-hidden rounded-2xl bg-neutral-100"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <img
          src={item.image}
          alt={item.caption}
          className="w-full object-contain"
        />
        {item.label && (
          <div
            ref={labelRef}
            className={`absolute flex items-center justify-center rounded-full bg-ink/80 text-[10px] font-semibold uppercase tracking-[0.2em] text-fog ${
              labelPositionMap[item.label.position] || "top-3 left-3"
            }`}
            style={labelStyle}
          >
            {item.label.type === "icon" ? "AI" : item.label.text}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-sm text-neutral-700">{item.caption}</p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-full border border-neu