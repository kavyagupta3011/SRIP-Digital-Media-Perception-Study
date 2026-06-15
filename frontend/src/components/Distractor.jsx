import { useEffect, useRef } from "react";
import { initJsPsych } from "jspsych";
import htmlButtonResponse from "@jspsych/plugin-html-button-response";

export default function Distractor({ onComplete, logger }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const jsPsych = initJsPsych({
      display_element: containerRef.current,
      on_finish: () => {
        const data = jsPsych.data.get().values();
        logger.logEvent("distractor_complete", { data });
        onComplete();
      }
    });

    const timeline = [
      {
        type: htmlButtonResponse,
        stimulus:
          "<div style='font-size:18px; font-weight:600;'>Quick word scramble</div><p>Reorder the letters to form a tech word: <strong>RAVES</strong></p>",
        choices: ["SERVA", "SAVER", "VERSA", "SERVER"],
        data: { task: "scramble", answer: "SERVER" }
      },
      {
        type: htmlButtonResponse,
        stimulus:
          "<div style='font-size:18px; font-weight:600;'>How relatable is this meme?</div><p>When the build finally passes after the 8th try.</p>",
        choices: ["Not me", "Somewhat", "Totally"],
        data: { task: "meme" }
      }
    ];

    jsPsych.run(timeline);
    return () => jsPsych.endExperiment("exit");
  }, [logger, onComplete]);

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl bg-glass p-8 text-ink shadow-card">
      <div ref={containerRef} />
    </section>
  );
}
