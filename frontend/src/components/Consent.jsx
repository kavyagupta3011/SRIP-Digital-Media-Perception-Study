import { motion } from "framer-motion";

export default function Consent({ onSubmit }) {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-2xl bg-glass p-8 text-ink shadow-card">
      <div className="space-y-2">
        <p className="text-sm uppercase tracking-[0.2em] text-neutral-500">
          Digital Media Perception Study
        </p>
        <h1 className="text-3xl font-semibold text-ink">
          Consent to Participate
        </h1>
        <p className="text-base text-neutral-600">
          You will browse and evaluate digital media content in a modern feed.
          Your interactions are recorded for research on attention and
          perception. You may stop at any time.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <motion.button
          whileTap={{ scale: 0.98 }}
          className="rounded-full bg-ink px-6 py-3 text-sm font-semibold text-fog"
          onClick={() => onSubmit(true)}
        >
          I Agree
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.98 }}
          className="rounded-full border border-neutral-200 bg-white px-6 py-3 text-sm font-semibold text-neutral-600"
          onClick={() => onSubmit(false)}
        >
          I Do Not Agree
        </motion.button>
      </div>
    </section>
  );
}
