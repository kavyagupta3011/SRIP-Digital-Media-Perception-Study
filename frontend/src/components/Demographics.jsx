import { useState } from "react";
import { motion } from "framer-motion";

const likert = [1, 2, 3, 4, 5];

export default function Demographics({ onSubmit }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    rollNumber: "",
    age: "",
    gender: "",
    aiUsage: 3,
    aiConfidence: 3
  });

  const updateField = (field, value) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit(form);
  };

  return (
    <section className="mx-auto w-full max-w-4xl rounded-2xl bg-glass p-8 text-ink shadow-card">
      <h2 className="text-2xl font-semibold">Participant Details</h2>
      <p className="mt-2 text-sm text-neutral-500">
        Please provide a few details before you start browsing.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 grid gap-5">
        <div className="grid gap-4 md:grid-cols-2">
          <input
            className="rounded-xl border border-neutral-200 px-4 py-3 text-sm"
            placeholder="Name"
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            required
          />
          <input
            className="rounded-xl border border-neutral-200 px-4 py-3 text-sm"
            placeholder="Email"
            type="email"
            value={form.email}
            onChange={(event) => updateField("email", event.target.value)}
            required
          />
          <input
            className="rounded-xl border border-neutral-200 px-4 py-3 text-sm"
            placeholder="Roll Number"
            value={form.rollNumber}
            onChange={(event) => updateField("rollNumber", event.target.value)}
            required
          />
          <input
            className="rounded-xl border border-neutral-200 px-4 py-3 text-sm"
            placeholder="Age"
            type="number"
            min="16"
            max="99"
            value={form.age}
            onChange={(event) => updateField("age", event.target.value)}
            required
          />
          <select
            className="rounded-xl border border-neutral-200 px-4 py-3 text-sm"
            value={form.gender}
            onChange={(event) => updateField("gender", event.target.value)}
            required
          >
            <option value="">Gender</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="nonbinary">Non-binary</option>
            <option value="prefer-not">Prefer not to say</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-neutral-100 bg-white/80 p-5 shadow-soft">
            <p className="text-sm font-semibold text-neutral-700">
              Frequency of generative AI usage
            </p>
            <div className="mt-3 flex gap-2">
              {likert.map((value) => (
                <button
                  type="button"
                  key={`usage-${value}`}
                  onClick={() => updateField("aiUsage", value)}
                  className={`h-10 w-10 rounded-full border text-sm font-semibold transition ${
                    form.aiUsage === value
                      ? "bg-ink text-fog"
                      : "border-neutral-200 bg-white text-neutral-500"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-neutral-100 bg-white/80 p-5 shadow-soft">
            <p className="text-sm font-semibold text-neutral-700">
              Confidence in detecting AI-generated media
            </p>
            <div className="mt-3 flex gap-2">
              {likert.map((value) => (
                <button
                  type="button"
                  key={`confidence-${value}`}
                  onClick={() => updateField("aiConfidence", value)}
                  className={`h-10 w-10 rounded-full border text-sm font-semibold transition ${
                    form.aiConfidence === value
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
          className="mt-2 w-fit rounded-full bg-ink px-6 py-3 text-sm font-semibold text-fog"
          type="submit"
        >
          Start Browsing
        </motion.button>
      </form>
    </section>
  );
}
