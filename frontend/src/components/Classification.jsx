import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export default function Classification({ items, onComplete, logger, participantId }) {
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState(null);
  const [reason, setReason] = useState("");
  const [confidence, setConfidence] = useState(3);
  const [startTime, setStartTime] = useState(performance.now());

  const current = items[index];

  useEffect(() => {
    setChoice(null);
    setReason("");
    setConfidence(3);
    setStartTime(performance.now());
  }, [index]);

  const wordCount = useMemo(() => {
    if (!reason.trim()) return 0;
    return reason.trim().split(/\s+/).length;
  }, [reason]);

  const handleSubmit = async () => {
    if (!choice) return;
    const responseTime = performance.now() - startTime;
    if (current.attentionCheck) {
      logger.logEvent("attention_check_response", {
        image_id: current.id,
        passed: choice === "ai"
      });
    }
    await logger.submitClassification({
      image_id: current.id,
      choice,
      reason: choice === "ai" ? reason.trim() : "",
      confidence,
      response_time_ms: responseTime,
      correct: choice === "ai" ? current.isAI : !current.isAI
    });
    if (index < items.length - 1) {
      setIndex((prev) => prev + 1);
    } else {
      onComplete();
    }
  };

  return (
    <section className="mx-auto w-full max-w-4xl rounded-2xl bg-glass p-8 text-ink shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Classification</h2>
        <p className="text-sm text-neutral-500">
          {index + 1} / {items.length}
        </p>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-[1.1fr_0.9fr]">
        <div className="overflow-hidden rounded-2xl border border-white/20 bg-neutral-100">
          <img src={current.image} alt={current.caption} className="w-full object-contain" />
        </div>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Do you think this image is real or AI-generated?
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setChoice("real")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                choice === "real"
                  ? "border border-slate-900 bg-slate-100 text-slate-900"
                  : "border border-neutral-200 bg-white text-neutral-600"
              }`}
            >
              Real
            </button>
            <button
              type="button"
              onClick={() => setChoice("ai")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                choice === "ai"
                  ? "border border-slate-900 bg-slate-100 text-slate-900"
                  : "border border-neutral-200 bg-white text-neutral-600"
              }`}
            >
              AI-generated
            </button>
          </div>
          <AnimatePresence initial={false}>
            {choice === "ai" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <label className="text-xs uppercase tracking-[0.2em] text-neutral-500">
                  What made you think this was AI-generated? (max 10 words)
                </label>
                <textarea
                  className="mt-2 w-full rounded-xl border border-neutral-200 px-4 py-3 text-sm"
                  rows={3}
                  value={reason}
                  onChange={(event) => {
                    const text = event.target.value;
                    if (text.trim().split(/\s+/).length <= 10) {
                      setReason(text);
                    }
                  }}
                />
                <p className="mt-1 text-xs text-neutral-400">
                  {wordCount} / 10 words
                </p>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="rounded-2xl border border-neutral-100 bg-white/80 p-4 shadow-soft">
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
              Confidence
            </p>
            <input
              type="range"
              min="1"
              max="5"
              step="1"
              value={confidence}
              onChange={(event) => setConfidence(Number(event.target.value))}
              className="mt-2 w-full"
            />
            <div className="mt-1 flex justify-between text-xs text-neutral-400">
              <span>1</span>
              <span>5</span>
            </div>
          </div>
          <motion.button
            whileTap={{ scale: 0.98 }}
            className="w-fit rounded-full bg-ink px-6 py-3 text-sm font-semibold text-fog"
            onClick={handleSubmit}
          >
            Submit
          </motion.button>
        </div>
      </div>
    </section>
  );
}
