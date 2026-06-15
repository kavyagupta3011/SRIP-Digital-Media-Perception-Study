import { useState } from "react";
import { motion } from "framer-motion";

export default function Awareness({ onComplete, logger }) {
  const [response, setResponse] = useState("");

  const handleSubmit = async () => {
    await logger.submitAwareness({ response });
    onComplete();
  };

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl bg-glass p-8 text-ink shadow-card">
      <h2 className="text-2xl font-semibold">Awareness Check</h2>
      <p className="mt-2 text-sm text-neutral-500">
        What do you think was the main purpose of this study?
      </p>
      <textarea
        className="mt-4 w-full rounded-2xl border border-neutral-200 px-4 py-3 text-sm"
        rows={4}
        value={response}
        onChange={(event) => setResponse(event.target.value)}
      />
      <motion.button
        whileTap={{ scale: 0.98 }}
        className="mt-4 rounded-full bg-ink px-6 py-3 text-sm font-semibold text-fog"
        onClick={handleSubmit}
      >
        Continue
      </motion.button>
    </section>
  );
}
