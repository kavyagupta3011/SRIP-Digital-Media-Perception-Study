import { useState } from "react";
import { motion } from "framer-motion";

const options = ["Strongly agree", "Agree", "Neutral", "Disagree", "Strongly disagree"];

export default function Policy({ onComplete, logger }) {
  const [responsibility, setResponsibility] = useState("");
  const [watermarking, setWatermarking] = useState("");

  const handleSubmit = async () => {
    await logger.submitPolicy({ responsibility, watermarking });
    onComplete();
  };

  return (
    <section className="mx-auto w-full max-w-4xl rounded-2xl bg-glass p-8 text-ink shadow-card">
      <h2 className="text-2xl font-semibold">Policy Perspectives</h2>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-neutral-100 bg-white/80 p-5 shadow-soft">
          <p className="text-sm font-semibold text-neutral-700">
            Who should be responsible for AI labels?
          </p>
          <div className="mt-3 grid gap-2">
            {["Platforms", "Model developers", "Regulators", "Creators"].map(
              (value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setResponsibility(value)}
                  className={`rounded-full border px-4 py-2 text-xs font-semibold transition ${
                    responsibility === value
                      ? "bg-ink text-fog"
                      : "border-neutral-200 bg-white text-neutral-500"
                  }`}
                >
                  {value}
                </button>
              )
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-neutral-100 bg-white/80 p-5 shadow-soft">
          <p className="text-sm font-semibold text-neutral-700">
            Should synthetic media watermarking be legally required?
          </p>
          <div className="mt-3 grid gap-2">
            {options.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setWatermarking(value)}
                className={`rounded-full border px-4 py-2 text-xs font-semibold transition ${
                  watermarking === value
                    ? "bg-ink text-fog"
                    : "border-neutral-200 bg-white text-neutral-500"
                }`}
              >
                {value}
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
        Finish
      </motion.button>
    </section>
  );
}
