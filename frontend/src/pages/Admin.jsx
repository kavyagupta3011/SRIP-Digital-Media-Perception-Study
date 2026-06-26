import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend,
} from "recharts";

const fmtPct    = (v) => v == null ? "—" : Math.round(v * 100) + "%";
const fmtMs     = (v) => v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + "s" : Math.round(v) + "ms";
const fmtNum    = (v) => v == null ? "—" : typeof v === "number" ? v.toFixed(2) : String(v);
const fmtPctBar = (v) => `${Math.round(v * 100)}%`;
const fmtR      = (v) => v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2);
const fmtP      = (v) => v == null ? "—" : v < 0.001 ? "p < .001" : `p = ${v.toFixed(3)}`;
const isSig     = (p) => p != null && p < 0.05;

const LABEL_NAMES = ["0% (none)", "0.1%", "0.25%", "0.5%", "1%", "1.5%"];
const BLUE_SCALE  = ["#94a3b8", "#93c5fd", "#3b82f6", "#1d4ed8", "#1e3a8a", "#172554"];
const PIE_COLORS  = ["#3b82f6","#f59e0b","#10b981","#f43f5e","#8b5cf6","#06b6d4"];

function Card({ children, className = "" }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white p-5 ${className}`}>{children}</div>;
}
function SectionTitle({ title, sub }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {sub && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}
function StatCard({ label, value, sub, color = "text-slate-900" }) {
  return (
    <Card>
      <p className="text-xs font-bold uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${color}`}>{value ?? "—"}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </Card>
  );
}
function NoData() {
  return <p className="py-6 text-center text-sm text-slate-400">No data yet.</p>;
}
const TT = ({ active, payload, label, fmt = (v) => v }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-lg">
      <p className="font-semibold text-slate-700">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.fill || p.color }}>
          {p.name}: <strong>{fmt(p.value)}</strong>
        </p>
      ))}
    </div>
  );
};
const SpotCheckSizeTT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-lg">
      <p className="font-semibold text-slate-700">{label}</p>
      <p style={{ color: "#3b82f6" }}>
        Detection rate: <strong>{fmtPct(row?.detection_rate)}</strong>
        {row?.detection_rate_ci && (
          <span className="text-slate-400"> (95% CI {Math.round(row.detection_rate_ci[0] * 100)}–{Math.round(row.detection_rate_ci[1] * 100)}%)</span>
        )}
      </p>
      {row?.accuracy != null && (
        <p style={{ color: "#10b981" }}>
          Accuracy: <strong>{fmtPct(row.accuracy)}</strong>
          {row?.accuracy_ci && (
            <span className="text-slate-400"> (95% CI {Math.round(row.accuracy_ci[0] * 100)}–{Math.round(row.accuracy_ci[1] * 100)}%)</span>
          )}
        </p>
      )}
      <p className="text-xs text-slate-400">n = {row?.n}</p>
    </div>
  );
};

function ResetModal({ onConfirm, onCancel }) {
  const [text, setText] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-3xl border border-red-100 bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-900">Reset all study data?</h3>
        <p className="mt-2 text-sm text-slate-600">Clears all CSVs and social data. Type <strong>RESET</strong> to confirm.</p>
        <input className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none"
          value={text} onChange={(e) => setText(e.target.value)} placeholder="Type RESET" autoFocus />
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onConfirm} disabled={text !== "RESET"}
            className="flex-1 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            Confirm reset
          </button>
          <button type="button" onClick={onCancel}
            className="flex-1 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Admin() {
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(sessionStorage.getItem("admin_authenticated") === "true");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [showReset, setShowReset] = useState(false);
  const adminPwd = () => sessionStorage.getItem("admin_password") || "";

  const loadStats = async () => {
    const res = await fetch("/api/admin/stats", { headers: { "X-Admin-Password": adminPwd() } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to load.");
    setStats(data);
  };

  useEffect(() => {
    if (!authenticated) return;
    loadStats().catch((e) => setError(e.message));
    const id = window.setInterval(() => loadStats().catch(() => {}), 30000);
    return () => window.clearInterval(id);
  }, [authenticated]);

  const login = async (e) => {
    e.preventDefault(); setError("");
    const res = await fetch("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.detail || "Invalid password."); return; }
    sessionStorage.setItem("admin_authenticated", "true");
    sessionStorage.setItem("admin_password", password);
    setAuthenticated(true);
  };

  const download = (type) =>
    window.open(`/api/admin/export/${type}?password=${encodeURIComponent(adminPwd())}`, "_blank");

  const doReset = async () => {
    setShowReset(false);
    const res = await fetch("/api/admin/reset", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Password": adminPwd() },
    });
    if (res.ok) loadStats(); else setError("Reset failed.");
  };

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-16">
        <form onSubmit={login} className="mx-auto max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Admin Dashboard</h1>
          <p className="mt-2 text-sm text-slate-600">Enter the admin password to continue.</p>
          <input className="mt-6 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none"
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" />
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button type="submit" className="mt-6 w-full rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white">Sign in</button>
        </form>
      </div>
    );
  }

  const s = stats;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 text-slate-900">
      {showReset && <ResetModal onConfirm={doReset} onCancel={() => setShowReset(false)} />}
      <div className="mx-auto max-w-7xl space-y-8">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">SRIP Research Dashboard</h1>
            <p className="mt-1 text-sm text-slate-500">Digital Media Perception Study — AI Label Effectiveness</p>
          </div>
          <a href="/" className="mt-1 text-sm font-medium text-slate-500 hover:text-slate-900">Back to study</a>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!s ? <p className="text-sm text-slate-500">Loading...</p> : (<>

        {/* 1. Participant overview */}
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-slate-400">Participant Overview</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Registered" value={s.total_users ?? 0} />
            <StatCard label="Completed" value={s.completed_studies ?? 0} color="text-blue-600" />
            <StatCard label="Completion rate" value={fmtPct(s.completion_rate)} color="text-blue-600" />
            <StatCard label="Live now" value={s.live_participants ?? 0} color="text-emerald-600" />
            <StatCard label="Dropouts" value={s.dropout_total ?? 0} color="text-red-500" />
            <StatCard label="Attn. check pass" value={fmtPct(s.attention_pass_rate)} sub="Validity indicator" />
          </div>
        </div>

        {/* 2. Core detection metrics */}
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-slate-400">Core Detection Metrics</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Overall accuracy" value={fmtPct(s.overall_accuracy)} sub="Correct / total images" />
            <StatCard label="Sensitivity (AI)" value={fmtPct(s.ai_detection_rate)} sub="P(say AI | is AI)" color="text-orange-600" />
            <StatCard label="Specificity (Real)" value={fmtPct(s.real_detection_rate)} sub="P(say Real | is real)" color="text-emerald-600" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Card>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">d-prime — Signal Detection</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{fmtNum(s.mean_dprime)}</p>
              <p className="mt-1 text-xs text-slate-500">d = z(H) - z(FA). Higher = better discrimination. 0 = chance, 1 = weak, 2+ = excellent. Computed per participant then averaged.</p>
            </Card>
            <Card>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Response Bias (c)</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{fmtNum(s.mean_response_bias)}</p>
              <p className="mt-1 text-xs text-slate-500">c = -0.5 x (z(H) + z(FA)). Positive = conservative (biased toward Real). Negative = liberal (biased toward AI Modified).</p>
            </Card>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Card>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Mean IES (Inverse Efficiency)</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{s.mean_ies != null ? Math.round(s.mean_ies) + "ms" : "—"}</p>
              <p className="mt-1 text-xs text-slate-500">IES = mean_RT / accuracy. Lower = faster AND more accurate. Avoids RT-accuracy tradeoff confound when comparing label conditions.</p>
            </Card>
            <Card>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Learning Effect (within session)</p>
              <p className={`mt-2 text-3xl font-bold ${s.mean_learning_effect > 0 ? "text-emerald-600" : s.mean_learning_effect < 0 ? "text-red-500" : "text-slate-900"}`}>
                {s.mean_learning_effect != null ? (s.mean_learning_effect > 0 ? "+" : "") + Math.round(s.mean_learning_effect * 100) + "pp" : "—"}
              </p>
              <p className="mt-1 text-xs text-slate-500">2nd-half accuracy minus 1st-half. Positive = learning. Negative = fatigue. Important confound to report in paper.</p>
            </Card>
          </div>
        </div>

        {/* 3. Accuracy by label size — core IV to DV */}
        <Card>
          <SectionTitle
            title="Accuracy by Label Size (Core Research Variable)"
            sub="Does disclosure label size (% of image area) improve AI detection? X-axis = label size, Y-axis = mean accuracy across participants."
          />
          {!(s.label_accuracy?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={s.label_accuracy.map((r, i) => ({ name: LABEL_NAMES[i], accuracy: r.accuracy }))}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 12 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Bar dataKey="accuracy" radius={[6, 6, 0, 0]} name="Accuracy">
                  {s.label_accuracy.map((_, i) => <Cell key={i} fill={BLUE_SCALE[i]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* 4. RT + Dwell by label size */}
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <SectionTitle title="Response Time by Label Size" sub="Mean decision latency per condition." />
            {!(s.rt_by_label?.length) ? <NoData /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={s.rt_by_label} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}s` : `${v}ms`} tick={{ fontSize: 11 }} />
                  <Tooltip content={<TT fmt={fmtMs} />} />
                  <Bar dataKey="ms" name="Avg RT" radius={[4, 4, 0, 0]}>
                    {s.rt_by_label.map((_, i) => <Cell key={i} fill={BLUE_SCALE[i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
          <Card>
            <SectionTitle title="Dwell Time by Label Size" sub="Mean time image was at least 50% visible before verdict." />
            {!(s.dwell_by_label?.length) ? <NoData /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={s.dwell_by_label} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}s` : `${v}ms`} tick={{ fontSize: 11 }} />
                  <Tooltip content={<TT fmt={fmtMs} />} />
                  <Bar dataKey="ms" name="Avg Dwell" radius={[4, 4, 0, 0]}>
                    {s.dwell_by_label.map((_, i) => <Cell key={i} fill={BLUE_SCALE[i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>

        {/* 5. Label noticeability */}
        <Card>
          <SectionTitle
            title="Label Noticeability Rate by Label Size"
            sub="% of participants whose mouse hovered on the label area for more than 200ms — proxy for whether the label was actually noticed."
          />
          {!(s.label_noticeability?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={s.label_noticeability} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 12 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Bar dataKey="noticeability_rate" name="% Noticed" radius={[4, 4, 0, 0]}>
                  {s.label_noticeability.map((_, i) => <Cell key={i} fill={BLUE_SCALE[i + 1] || "#1e3a8a"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* 5b. Label nudge effect — KEY behavioral metric */}
        <Card>
          <SectionTitle
            title="Label Nudge Effect — Core Behavioral Metric"
            sub='P(say "AI Modified") per label condition vs no-label baseline. This is the pure causal effect of the label on behavior, independent of accuracy. A positive nudge means the label increased AI identifications.'
          />
          {!(s.label_nudge_effect?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.label_nudge_effect} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={fmtPctBar} tick={{ fontSize: 11 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Legend />
                <Bar dataKey="baseline" name="Baseline (no label)" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="compliance" name="With label" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="nudge" name="Nudge delta" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* 5c. Label position */}
        <Card>
          <SectionTitle
            title="Accuracy and Noticeability by Label Position"
            sub="Does the corner where the AI label appears affect detection? Captures visual attention asymmetry across screen quadrants."
          />
          {!(s.label_position_accuracy?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={s.label_position_accuracy} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="position" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 11 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Legend />
                <Bar dataKey="accuracy" name="Accuracy" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="noticeability_rate" name="Noticeability" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* 5d. Post-feed single-image spot check */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
          <StatCard
            label="Spot-check false positive rate"
            value={fmtPct(s.spot_check_false_positive_rate)}
            sub='Said "Yes" when there was no label at all'
            color="text-red-500"
          />
          <StatCard
            label="Fast-guess rate"
            value={fmtPct(s.spot_check_fast_guess_rate)}
            sub="Said Yes on a small label in <1.5s — likely guessing, not real detection"
            color="text-amber-600"
          />
        </div>

        <Card>
          <SectionTitle
            title="Spot-Check Detection Rate by Label Size"
            sub='Single post-feed image, "Can you spot a label in this image?" — % who answered Yes, per label-size condition (0% = no label present, so this bucket is the false-positive rate). Hover a bar for its 95% confidence interval (Wilson score) — with one observation per participant per bucket, point estimates alone can be misleading at low n.'
          />
          {!(s.spot_check_by_size?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.spot_check_by_size} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 12 }} />
                <Tooltip content={<SpotCheckSizeTT />} />
                <Bar dataKey="detection_rate" name="% said Yes" radius={[6, 6, 0, 0]}>
                  {s.spot_check_by_size.map((_, i) => <Cell key={i} fill={BLUE_SCALE[i] || "#1e3a8a"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle
            title="Spot-Check Response Time by Size and Answer"
            sub='Time from image fully loaded to answer, split by Yes/No. A fast "Yes" on a large label means it is highly noticeable. A slower "Yes" on a small label suggests genuine effortful search. A suspiciously fast "Yes" on a small label suggests random guessing rather than real detection — used to find the optimal noticeable label size.'
          />
          {!(s.spot_check_response_time_by_size?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.spot_check_response_time_by_size} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}s` : `${v}ms`} tick={{ fontSize: 11 }} />
                <Tooltip content={<TT fmt={fmtMs} />} />
                <Legend />
                <Bar dataKey="rt_yes_ms" name="Avg RT (said Yes)" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="rt_no_ms" name="Avg RT (said No)" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle
            title="Spot-Check Sensitivity (d') by Label Size"
            sub="d' isolates genuine detectability from a participant's overall yes-bias by holding the false-alarm rate fixed at the 0% bucket — the same SDT treatment already used for the main AI-detection task, applied here to the spot-check itself. Criterion > 0 = cautious/says-No bias; < 0 = liberal/says-Yes bias."
          />
          {!(s.spot_check_dprime_by_size?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.spot_check_dprime_by_size} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip content={<TT fmt={fmtNum} />} />
                <Legend />
                <Bar dataKey="dprime" name="d' (sensitivity)" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="criterion" name="Criterion (bias)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle
            title="Spot-Check Detection Rate by Label Position"
            sub="Detection rate and accuracy for labeled spot-check images, broken out by which corner the label sits in. Catches reading-order / visual-scanning effects (e.g. top-left noticed more) independent of label size."
          />
          {!(s.spot_check_by_position?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={s.spot_check_by_position} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="position" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 12 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Legend />
                <Bar dataKey="detection_rate" name="Detection rate" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="accuracy" name="Accuracy" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Psychometric detection threshold + significance tests */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="50% detection threshold"
            value={s.spot_check_psychometric?.threshold_50 != null ? `${s.spot_check_psychometric.threshold_50.toFixed(2)}%` : "—"}
            sub={s.spot_check_psychometric?.threshold_50_ci
              ? `95% CI ${s.spot_check_psychometric.threshold_50_ci[0].toFixed(2)}–${s.spot_check_psychometric.threshold_50_ci[1].toFixed(2)}%`
              : "Label size where half of people notice it — needs more data to fit"}
          />
          <StatCard
            label="75% detection threshold"
            value={s.spot_check_psychometric?.threshold_75 != null ? `${s.spot_check_psychometric.threshold_75.toFixed(2)}%` : "—"}
            sub={s.spot_check_psychometric?.threshold_75_ci
              ? `95% CI ${s.spot_check_psychometric.threshold_75_ci[0].toFixed(2)}–${s.spot_check_psychometric.threshold_75_ci[1].toFixed(2)}%`
              : "Needs more data to fit"}
          />
          <StatCard
            label="Detection ~ size slope"
            value={fmtNum(s.spot_check_psychometric?.slope)}
            sub={s.spot_check_psychometric ? `Logistic fit, ${fmtP(s.spot_check_psychometric.slope_p_value)}` : "Needs more data to fit"}
            color={isSig(s.spot_check_psychometric?.slope_p_value) ? "text-emerald-600" : "text-slate-900"}
          />
          <StatCard
            label="Size affects Yes/No?"
            value={s.spot_check_chi_square ? `χ² = ${s.spot_check_chi_square.statistic}` : "—"}
            sub={s.spot_check_chi_square ? `df=${s.spot_check_chi_square.dof}, ${fmtP(s.spot_check_chi_square.p_value)}, n=${s.spot_check_chi_square.n}` : "No data yet"}
            color={isSig(s.spot_check_chi_square?.p_value) ? "text-emerald-600" : "text-slate-900"}
          />
        </div>

        <Card>
          <SectionTitle
            title="Spot-Check Detection vs. Main-Feed Accuracy"
            sub="Does noticing the spot-check label predict doing better at the actual real-vs-AI judgment? Compares average main-feed accuracy for participants who did vs. didn't correctly answer the spot check, plus the point-biserial correlation between the two."
          />
          {!s.spot_check_vs_feed_accuracy ? <NoData /> : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Detected the label</p>
                <p className="mt-1 text-xl font-bold text-emerald-600">{fmtPct(s.spot_check_vs_feed_accuracy.mean_accuracy_when_detected)}</p>
                <p className="text-xs text-slate-400">avg feed accuracy, n={s.spot_check_vs_feed_accuracy.n_detected}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Missed the label</p>
                <p className="mt-1 text-xl font-bold text-red-500">{fmtPct(s.spot_check_vs_feed_accuracy.mean_accuracy_when_missed)}</p>
                <p className="text-xs text-slate-400">avg feed accuracy, n={s.spot_check_vs_feed_accuracy.n_missed}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Correlation</p>
                <p className={`mt-1 text-xl font-bold ${isSig(s.spot_check_vs_feed_accuracy.correlation?.p_value) ? "text-emerald-600" : "text-slate-900"}`}>
                  {fmtR(s.spot_check_vs_feed_accuracy.correlation?.r)}
                </p>
                <p className="text-xs text-slate-400">
                  {s.spot_check_vs_feed_accuracy.correlation ? fmtP(s.spot_check_vs_feed_accuracy.correlation.p_value) : "—"}, n={s.spot_check_vs_feed_accuracy.correlation?.n ?? "—"}
                </p>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle
            title="Demographic Correlations"
            sub="Pearson correlation (Likert scales treated as interval — the standard approximation for scales this short) between age / self-reported AI-tool usage frequency / AI-detection confidence, and both overall feed accuracy and spot-check detection success."
          />
          {!s.demographic_correlations ? <NoData /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-bold uppercase tracking-widest text-slate-400">
                    <th className="py-2 pr-2">Pair</th>
                    <th className="py-2 pr-2">r</th>
                    <th className="py-2 pr-2">p-value</th>
                    <th className="py-2">n</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Age vs. feed accuracy", s.demographic_correlations.age_vs_accuracy],
                    ["AI-usage frequency vs. feed accuracy", s.demographic_correlations.ai_frequency_vs_accuracy],
                    ["AI-detection confidence vs. feed accuracy", s.demographic_correlations.ai_confidence_vs_accuracy],
                    ["Age vs. spot-check detection", s.demographic_correlations.age_vs_spot_check_detection],
                    ["AI-usage frequency vs. spot-check detection", s.demographic_correlations.ai_frequency_vs_spot_check_detection],
                    ["AI-detection confidence vs. spot-check detection", s.demographic_correlations.ai_confidence_vs_spot_check_detection],
                  ].map(([name, corr]) => (
                    <tr key={name} className="border-b border-slate-100">
                      <td className="py-2 pr-2 text-slate-700">{name}</td>
                      <td className={`py-2 pr-2 font-semibold ${isSig(corr?.p_value) ? "text-emerald-600" : "text-slate-900"}`}>{fmtR(corr?.r)}</td>
                      <td className="py-2 pr-2 text-slate-500">{corr ? fmtP(corr.p_value) : "—"}</td>
                      <td className="py-2 text-slate-500">{corr?.n ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* 6. Per-category accuracy */}
        <Card>
          <SectionTitle
            title="Accuracy by Image Category"
            sub="Detection accuracy per topic category. Reveals which real-world contexts make AI manipulation harder to spot."
          />
          {!(s.per_category_accuracy?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.per_category_accuracy.map((r) => ({ name: r.category, accuracy: r.accuracy }))}
                margin={{ top: 5, right: 10, left: 0, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" interval={0} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 11 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Bar dataKey="accuracy" fill="#3b82f6" name="Accuracy" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* 7. Feed position + AI familiarity */}
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <SectionTitle title="Accuracy by Feed Position" sub="Position 1 = first image seen. Shows learning or fatigue across the feed." />
            {!(s.feed_position_accuracy?.length) ? <NoData /> : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={s.feed_position_accuracy.map((r) => ({ name: `#${r.position}`, accuracy: r.accuracy }))}
                  margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 11 }} />
                  <Tooltip content={<TT fmt={fmtPct} />} />
                  <Line type="monotone" dataKey="accuracy" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4, fill: "#3b82f6" }} name="Accuracy" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>
          <Card>
            <SectionTitle title="Accuracy by AI Familiarity" sub="1 = never used AI tools, 5 = very experienced. Tests whether expertise predicts detection." />
            {!(s.accuracy_by_confidence?.length) ? <NoData /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={s.accuracy_by_confidence.map((r) => ({ name: `Level ${r.confidence}`, accuracy: r.accuracy }))}
                  margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 11 }} />
                  <Tooltip content={<TT fmt={fmtPct} />} />
                  <Bar dataKey="accuracy" fill="#8b5cf6" name="Accuracy" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>

        {/* 8. Social behavior by image type */}
        <Card>
          <SectionTitle
            title="Like and Share Rate by Image Type"
            sub="Did participants engage differently with real vs AI images? Reveals implicit bias in social media behavior even without explicit detection."
          />
          {!(s.like_rate_by_type?.length) ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={s.like_rate_by_type.map((r) => ({ name: r.type, like: r.like_rate, share: r.share_rate }))}
                margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 1]} tickFormatter={fmtPctBar} tick={{ fontSize: 11 }} />
                <Tooltip content={<TT fmt={fmtPct} />} />
                <Legend />
                <Bar dataKey="like" name="Like rate" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                <Bar dataKey="share" name="Share rate" fill="#f43f5e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* 9. Demographics */}
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <SectionTitle title="Gender Distribution" sub="Self-reported gender of completed participants." />
            {!(s.demographics?.gender?.length) ? <NoData /> : (() => {
              const total = s.demographics.gender.reduce((a, g) => a + g.count, 0);
              return (
                <div className="flex items-center gap-6">
                  <PieChart width={180} height={180}>
                    <Pie data={s.demographics.gender.map((g) => ({ name: g.label, value: g.count }))}
                      cx={85} cy={85} outerRadius={75} dataKey="value"
                      label={({ name, percent }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false}>
                      {s.demographics.gender.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                  <div className="space-y-2">
                    {s.demographics.gender.map((g, i) => (
                      <div key={g.label} className="flex items-center gap-2 text-sm">
                        <div className="h-3 w-3 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                        <span className="text-slate-700">{g.label}</span>
                        <span className="font-semibold">{g.count}</span>
                        <span className="text-slate-400">({total ? Math.round(g.count / total * 100) : 0}%)</span>
                      </div>
                    ))}
                    {s.demographics.age_mean != null && (
                      <div className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                        <p>Age mean: <strong>{s.demographics.age_mean}</strong></p>
                        <p>Range: <strong>{s.demographics.age_min}–{s.demographics.age_max}</strong></p>
                        <p>N = <strong>{s.demographics.total_count}</strong></p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </Card>
          <Card>
            <SectionTitle title="Dropout Funnel" sub="Pages where participants abandoned the study." />
            {!(s.dropout_by_page?.length) ? (
              <p className="py-6 text-center text-sm text-slate-400">No dropouts recorded.</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={s.dropout_by_page.map((d) => ({ name: d.label, count: d.count }))}
                  layout="vertical" margin={{ top: 0, right: 10, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#f87171" name="Dropouts" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>

        {/* 10. Social engagement */}
        <Card>
          <SectionTitle title="Social Engagement (Community Wall)" sub="Post-study social activity." />
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Wall posts", val: s.social_stats?.wall_posts ?? 0 },
              { label: "Post likes", val: s.social_stats?.total_likes ?? 0 },
              { label: "Direct messages", val: s.social_stats?.total_messages ?? 0 },
            ].map((d) => (
              <div key={d.label} className="rounded-xl bg-slate-50 p-4 text-center">
                <p className="text-2xl font-bold text-slate-900">{d.val}</p>
                <p className="mt-1 text-xs font-medium text-slate-500">{d.label}</p>
              </div>
            ))}
          </div>
        </Card>

        {/* 11. Recent submissions */}
        <Card>
          <SectionTitle title="Recent Submissions" />
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  {["Session", "Name", "Accuracy", "Duration"].map((h) => (
                    <th key={h} className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!(s.recent_submissions?.length) ? (
                  <tr><td colSpan={4} className="py-4 text-sm text-slate-400">No submissions yet.</td></tr>
                ) : s.recent_submissions.map((row) => (
                  <tr key={row.session_id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2 pr-4 font-mono text-xs text-slate-400">{String(row.session_id || "").slice(0, 8)}</td>
                    <td className="py-2 pr-4 font-medium text-slate-800">{row.name || "—"}</td>
                    <td className="py-2 pr-4 font-semibold text-slate-900">{fmtPct(row.overall_accuracy)}</td>
                    <td className="py-2 text-slate-600">{row.total_duration_minutes != null ? row.total_duration_minutes + " min" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Downloads + Reset */}
        <div className="flex flex-wrap gap-3">
          {[["responses","Download responses.csv"],["participants","Download participants.csv"],["dropouts","Download dropouts.csv"],["spot_checks","Download spot_checks.csv"]].map(([type, label]) => (
            <button key={type} type="button" onClick={() => download(type)}
              className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              {label}
            </button>
          ))}
          <button type="button" onClick={() => setShowReset(true)}
            className="rounded-full border border-red-200 bg-red-50 px-5 py-2 text-sm font-semibold text-red-700 hover:bg-red-100">
            Reset study data
          </button>
        </div>

        </>)}
      </div>
    </div>
  );
}

export default Admin;
