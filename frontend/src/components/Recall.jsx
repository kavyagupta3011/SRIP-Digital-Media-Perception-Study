import { useState } from "react";
import { motion } from "framer-motion";

export default function Recall({ items, onComplete, logger }) {
  const [aiSelected, setAiSelected] = useState([]);
  const [labelSelected, setLabelSelected] = useState([]);

  const toggleSelection = (list, setList, id) => {
    setList((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSubmit = async () => {
    await logger.submitRecall({
      ai_selected: aiSelected,
      label_selected: labelSelected
    });
    onComplete();
  };

  return (
    <section className="mx-auto w-full max-w-5xl rounded-2xl bg-glass p-8 text-ink shadow-card">
      <h2 className="text-2xl font-semibold">Recall</h2>
      <p className="mt-2 text-sm text-neutral-500">
        Select the images you remember as AI-generated, and those with visible
        labels.
      </p>
      <div className="mt-6 grid gap-6">
        <div>
          <p className="text-sm font-semibold text-neutral-700">AI-generated</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <button
                key={`ai-${item.id}`}
                type="button"
                onClick={() => toggleSelection(aiSelected, setAiSelected, item.id)}
                className={`overflow-hidden rounded-2xl border transition ${
                  aiSelected.includes(item.id)
                    ? "border-ink"
                    : "border-transparent"
                }`}
              >
                <img src={item.image} alt={item.caption} className="w-full" />
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-sm font-semibold text-neutral-700">Visible labels</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <button
                key={`label-${item.id}`}
                type="button"
                onClick={() =>
                  toggleSelection(labelSelected, setLabelSelected, item.id)
                }
                className={`overflow-hidden rounded-2xl border transition ${
                  labelSelected.includes(item.id)
                    ? "border-ink"
                    : "border-transparent"
                }`}
              >
                <img src={item.image} alt={item.caption} className="w-full" />
              </button>
            ))}
          </div>
        </div>
      </div>
      <motion.button
        whileTap={{ scale: 0.98 }}
        className="mt-6 rounded-full bg-ink px-6 py-3 text-sm font-semibold text-fog"
        onClick={handleSubmit}
      >
        Continue
      </motion.button>
    </section>
  );
}
