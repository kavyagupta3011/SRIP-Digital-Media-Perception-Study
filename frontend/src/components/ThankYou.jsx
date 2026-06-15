export default function ThankYou() {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 rounded-2xl bg-glass p-10 text-center text-ink shadow-card">
      <h2 className="text-3xl font-semibold">Thank you for participating!</h2>
      <p className="text-sm text-neutral-500">Your responses have been recorded.</p>
      <div className="text-neutral-400">─────────────────────────────────────────</div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" className="rounded-full bg-ink px-6 py-3 text-sm font-semibold text-fog">Browse Community Wall →</button>
        <button type="button" className="rounded-full border border-neutral-200 bg-white px-6 py-3 text-sm font-semibold text-neutral-600">Done</button>
      </div>
    </section>
  );
}
