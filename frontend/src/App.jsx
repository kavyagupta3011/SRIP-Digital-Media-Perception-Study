import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import MessagesPage from "./pages/Messages.jsx";
import { ATTENTION_CHECK_ID, buildFeedDisplayItems, getDeviceInfo, isOnline } from "./utils/tracking.js";

const CONSENT_TEXT = `This study examines how people perceive AI-modified images in a social media feed.

You will see a sequence of posts and we will record your scrolling behavior, response timing, and answers.

Participation is voluntary. You may stop at any time before submitting your responses.

No personal identifiers will be used in reports.`;

const GENDER_OPTIONS = ["Male", "Female", "Other", "Choose not to say"];
const AI_FREQUENCY_LABELS = ["Never", "Rarely", "Monthly", "Weekly", "Daily"];
const AI_CONFIDENCE_LABELS = ["Not at all", "Slightly", "Moderately", "Very", "Extremely"];
const LEGAL_SCALE_LABELS = ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"];
const RESPONSIBILITY_OPTIONS = [
  "The person who created it",
  "The AI tool used",
  "The social media platform",
  "Government/Regulatory bodies"
];
const LABEL_LOOKUP = { 0: "none", 0.5: "0.5%", 1: "1.0%", 1.5: "1.5%", 2: "2.0%" };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function hashColor(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360} 70% 46%)`;
}

function buildResponse() {
  return {
    verdict: null,
    reason: "",
    dwell_ms: 0,
    response_time_ms: null,
    liked: false,
    shared: false,
    shared_with_count: 0,
    share_recipients: "",
    community_wall_likes: 0,
    scroll_revisits: 0,
    revisit_scroll_up: 0,
    revisit_scroll_down: 0,
    firstSeenAt: null,
    shared_post_id: null,
    label_hover_ms: 0,
    zoom_count: 0,
    image_load_time_ms: null,
    image_load_started_at: null,
    revisits_post_verdict: 0,
    revisit_scroll_up_post: 0,
    revisit_scroll_down_post: 0,
    verdict_changed: false,
    verdict_change_count: 0
  };
}

function authHeaders(token, extra = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

function Spinner({ label = "Loading" }) {
  return (
    <div className="flex items-center justify-center gap-3 text-sm text-slate-600">
      <span className="srip-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ProgressBar({ value }) {
  return (
    <div className="fixed left-0 top-0 z-50 h-1 w-full bg-transparent">
      <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${clamp(value, 0, 100)}%` }} />
    </div>
  );
}

function Panel({ children, className = "" }) {
  return <section className={`srip-panel ${className}`}>{children}</section>;
}

function Title({ eyebrow, title, description }) {
  return (
    <div className="space-y-2">
      {eyebrow ? <p className="srip-eyebrow">{eyebrow}</p> : null}
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">{title}</h1>
      {description ? <p className="max-w-3xl text-sm leading-7 text-slate-600 md:text-base">{description}</p> : null}
    </div>
  );
}

function Button({ variant = "primary", className = "", ...props }) {
  const base =
    "inline-flex items-center justify-center rounded-full px-6 py-3 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "secondary"
      ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
      : "bg-slate-900 text-white hover:bg-slate-800";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

function Likert({ value, onChange, labels, ariaLabel }) {
  return (
    <div className="grid grid-cols-5 gap-2 md:gap-3">
      {labels.map((label, index) => {
        const number = index + 1;
        const active = value === number;
        return (
          <button
            key={label}
            type="button"
            aria-label={`${ariaLabel}: ${label}`}
            onClick={() => onChange(number)}
            className={`flex min-h-[68px] flex-col items-center justify-center rounded-2xl border px-3 py-2 text-center transition ${
              active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span className="text-base font-semibold">{number}</span>
            <span className="mt-1 text-[11px] leading-4">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ConsentPage({ onAgree, onExit }) {
  return (
    <Panel className="mx-auto w-full max-w-3xl p-6 md:p-10">
      <Title eyebrow="Digital Media Perception Study" title="Digital Media Perception Study" description="Please review the consent information before continuing." />
      <div className="mt-6 max-h-72 overflow-y-auto rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm leading-7 text-slate-700">
        <pre className="whitespace-pre-wrap font-sans">{CONSENT_TEXT}</pre>
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button onClick={onAgree}>I Agree - Begin Study</Button>
        <Button variant="secondary" onClick={onExit}>I Do Not Agree - Exit</Button>
      </div>
    </Panel>
  );
}

function DemographicsPage({ participant, setParticipant, onContinue }) {
  const [error, setError] = useState("");
  const update = (key, value) => setParticipant((prev) => ({ ...prev, [key]: value }));

  const submit = (event) => {
    event.preventDefault();
    const required = [participant.name, participant.email, participant.age, participant.gender, participant.ai_frequency, participant.ai_confidence];
    if (required.some((value) => value === "" || value === null || value === undefined)) {
      setError("Please complete all fields before continuing.");
      return;
    }
    setError("");
    onContinue();
  };

  return (
    <Panel className="mx-auto w-full max-w-4xl p-6 md:p-10">
      <Title eyebrow="Step 2 of 8" title="Tell us a little about yourself" description="These fields are required and will be saved with your survey responses." />
      <form onSubmit={submit} className="mt-8 space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          {/* name and email are locked — set during sign-in */}
          <div className="srip-input flex items-center gap-2 bg-slate-50 text-slate-500 cursor-not-allowed select-none">
            <span className="text-slate-400 text-xs font-medium uppercase tracking-wide mr-1">Name</span>
            <span className="text-slate-800 font-medium">{participant.name}</span>
          </div>
          <div className="srip-input flex items-center gap-2 bg-slate-50 text-slate-500 cursor-not-allowed select-none">
            <span className="text-slate-400 text-xs font-medium uppercase tracking-wide mr-1">Email</span>
            <span className="text-slate-800 font-medium">{participant.email}</span>
          </div>
          <input className="srip-input" placeholder="Age" type="number" min="1" value={participant.age} onChange={(e) => update("age", e.target.value)} required />
          <select className="srip-input" value={participant.gender} onChange={(e) => update("gender", e.target.value)} required>
            <option value="">Gender</option>
            {GENDER_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <div className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-500">Name &amp; Email are locked from sign-in</div>
        </div>
        <div className="grid gap-5">
          <div className="rounded-[22px] border border-slate-200 p-5">
            <p className="text-sm font-semibold text-slate-900">How frequently do you use Generative AI tools?</p>
            <div className="mt-3">
              <Likert value={participant.ai_frequency} labels={AI_FREQUENCY_LABELS} onChange={(value) => update("ai_frequency", value)} ariaLabel="Generative AI usage frequency" />
            </div>
          </div>
          <div className="rounded-[22px] border border-slate-200 p-5">
            <p className="text-sm font-semibold text-slate-900">How confident are you in spotting AI-generated media?</p>
            <div className="mt-3">
              <Likert value={participant.ai_confidence} labels={AI_CONFIDENCE_LABELS} onChange={(value) => update("ai_confidence", value)} ariaLabel="AI confidence" />
            </div>
          </div>
        </div>
        {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
        <Button type="submit">Continue -&gt;</Button>
      </form>
    </Panel>
  );
}

function InstructionsPage({ onContinue }) {
  return (
    <Panel className="mx-auto w-full max-w-4xl p-6 md:p-10">
      <Title eyebrow="Step 3 of 8" title="Feed instructions" description="You will now see a social media feed with 10 posts. For each image, scroll naturally and then tell us whether you think it is Real or AI Modified. Take as much time as you need." />
      <div className="mt-6 rounded-[26px] border border-slate-200 bg-slate-50 p-6 text-sm leading-7 text-slate-700">
        Keep your browsing natural. You can like or share posts, but your main task is to judge whether each image is real or AI modified.
      </div>
      <div className="mt-6">
        <Button onClick={onContinue}>Start Browsing -&gt;</Button>
      </div>
    </Panel>
  );
}

function AuthPage({ onAuthenticated, onCompletedStudy, onDevMode }) {
  const [email, setEmail]     = useState("");
  const [name, setName]       = useState("");
  const [otp, setOtp]         = useState("");
  // "email" → "info" (new) or "otp" (existing)
  const [stage, setStage]     = useState("email");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [devOtp, setDevOtp]   = useState("");
  const [showDevOtp, setShowDevOtp] = useState(false);
  const [isNew, setIsNew]     = useState(false);
  const [completedNotice, setCompletedNotice] = useState("");

  // Delay showing the fallback-code box for a few seconds so it reads like
  // "you didn't get the email, so here's another way" rather than popping up
  // instantly alongside "We sent a code to your email".
  useEffect(() => {
    if (!devOtp) { setShowDevOtp(false); return undefined; }
    setShowDevOtp(false);
    const timer = setTimeout(() => setShowDevOtp(true), 5000);
    return () => clearTimeout(timer);
  }, [devOtp]);

  // Step 1 – just check if the email is registered (no OTP yet)
  const checkEmail = async (event) => {
    event.preventDefault();
    if (!email.trim()) { setError("Please enter your email address."); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch(`/api/auth/check-email?email=${encodeURIComponent(email.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not reach server.");
      if (data.exists) {
        // existing user → send OTP immediately, jump to OTP entry
        setIsNew(false);
        await doSendOtp(false);
      } else {
        // new user → collect profile first
        setIsNew(true);
        setStage("info");
      }
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  };

  // Sends OTP (called internally, not directly by a form submit)
  const doSendOtp = async (isNewUser) => {
    const res  = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), name: isNewUser ? name : "" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not send OTP.");
    if (data.study_completed) setCompletedNotice("You have already completed this study. You can still access the Community Wall after signing in.");
    if (data.dev_otp) { setDevOtp(data.dev_otp); if (onDevMode) onDevMode(); }
    setStage("otp");
  };

  // Step 2 (new users) – collect name + roll no, then send OTP
  const submitInfo = async (event) => {
    event.preventDefault();
    if (!name.trim()) { setError("Please enter your full name."); return; }
    setLoading(true); setError("");
    try {
      await doSendOtp(true);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  };

  // Step 3 – verify OTP, save profile for new users
  const verifyOtp = async (event) => {
    event.preventDefault();
    if (!otp.trim()) { setError("Please enter the 6-digit OTP."); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), otp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Incorrect OTP, please try again.");

      if (isNew && name.trim()) {
        await fetch("/api/auth/update-profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${data.token}` },
          body: JSON.stringify({ name }),
        });
      }

      const displayName = isNew ? name : (data.name || "");
      const userObj = { user_id: data.user_id, name: displayName, email: email.trim(), study_completed: data.study_completed };
      localStorage.setItem("srip_token", data.token);
      localStorage.setItem("srip_user", JSON.stringify(userObj));

      if (data.study_completed) {
        onCompletedStudy({ token: data.token, user: { ...userObj, study_completed: true } });
        return;
      }
      onAuthenticated({ token: data.token, user: userObj });
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  };

  return (
    <Panel className="mx-auto w-full max-w-md p-8 md:p-10">

      {/* ── Stage: email ── */}
      {stage === "email" ? (
        <>
          <Title eyebrow="Research study" title="Welcome" description="Enter your email to get started." />
          {completedNotice ? <p className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">{completedNotice}</p> : null}
          <form className="mt-8 space-y-4" onSubmit={checkEmail}>
            <input className="srip-input" placeholder="you@email.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Checking…" : "Next →"}</Button>
          </form>
        </>
      ) : null}

      {/* ── Stage: info (new users only) ── */}
      {stage === "info" ? (
        <>
          <Title eyebrow="New participant" title="Create your profile" description="This information is saved once and cannot be changed later." />
          <form className="mt-8 space-y-4" onSubmit={submitInfo}>
            <input className="srip-input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Sending OTP…" : "Send OTP →"}</Button>
            <button type="button" className="w-full text-sm text-slate-400 hover:text-slate-600" onClick={() => { setStage("email"); setError(""); setIsNew(false); }}>← Back</button>
          </form>
        </>
      ) : null}

      {/* ── Stage: otp ── */}
      {stage === "otp" ? (
        <>
          <Title
            eyebrow={isNew ? "Almost there" : "Welcome back"}
            title="Check your email"
            description={`We sent a 6-digit code to ${email}. It expires in 10 minutes.`}
          />
          {completedNotice ? <p className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">{completedNotice}</p> : null}
          <form className="mt-8 space-y-4" onSubmit={verifyOtp}>
            <input className="srip-input text-center text-2xl tracking-[0.5em]" placeholder="······" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="off" />
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Verifying…" : "Verify →"}</Button>
            <button type="button" className="w-full text-sm text-slate-400 hover:text-slate-600" onClick={() => { setStage(isNew ? "info" : "email"); setOtp(""); setError(""); }}>← Back</button>
          </form>
          {devOtp && showDevOtp ? <p className="mt-4 rounded-xl bg-yellow-50 px-4 py-2 text-center text-sm font-medium text-yellow-800">Unable to get OTP? Use this instead: <strong>{devOtp}</strong></p> : null}
        </>
      ) : null}

      {error ? <p className="mt-4 text-center text-sm font-medium text-red-600">{error}</p> : null}
    </Panel>
  );
}


function HeaderBar({ user, unreadCount, messageUnreadCount, notificationsOpen, onToggleNotifications, onOpenMessages, onOpenWall, onLogout, studyCompleted }) {
  return (
    <div className="sticky top-0 z-40 mb-4 border-b border-slate-200 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
        <div>
          <p className="srip-eyebrow">Signed in</p>
          <p className="text-sm font-semibold text-slate-900">{user?.name || user?.email || "Participant"}</p>
        </div>
        <div className="flex items-center gap-3">
          {studyCompleted ? (
            <>
              <Button variant="secondary" onClick={onOpenWall}>Community Wall</Button>
              <Button variant="secondary" onClick={onOpenMessages}>
                Messages
                {messageUnreadCount > 0 ? <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">{messageUnreadCount}</span> : null}
              </Button>
            </>
          ) : null}
          <button type="button" onClick={onToggleNotifications} className="relative rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            🔔 Notifications
            {unreadCount > 0 ? <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">{unreadCount}</span> : null}
          </button>
          <Button variant="secondary" onClick={onLogout}>Log out</Button>
        </div>
      </div>
    </div>
  );
}

function NotificationPopover({ notifications, studyCompleted, onClose, onViewWall, onSelectNotification }) {
  return (
    <div className="absolute right-4 top-16 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-[24px] border border-slate-200 bg-white p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-900">Notifications</p>
        <button type="button" onClick={onClose} className="text-sm font-medium text-slate-500 hover:text-slate-800">Close</button>
      </div>
      <div className="mt-3 max-h-80 space-y-3 overflow-y-auto">
        {notifications.length === 0 ? <p className="text-sm text-slate-500">No unread notifications.</p> : null}
        {notifications.slice(0, 10).map((notification) => (
          <button
            key={notification.id || notification.notif_id}
            type="button"
            onClick={() => onSelectNotification(notification)}
            className="w-full rounded-2xl border border-slate-100 bg-slate-50 p-3 text-left text-sm text-slate-700 hover:bg-slate-100"
          >
            <div className="flex gap-3">
              {notification.image_thumbnail_url ? <img src={notification.image_thumbnail_url} alt="" className="h-12 w-12 rounded-xl object-cover" /> : null}
              <div>
                <p className="font-semibold text-slate-900">{notification.from_name || notification.from_email || "Someone"}</p>
                <p>{notification.type === "share" ? "shared a post with you" : notification.type}</p>
                {notification.feed_caption ? <p className="mt-1 text-xs text-slate-500">{notification.feed_caption}</p> : null}
                {!studyCompleted ? <p className="mt-1 text-xs text-amber-700">Complete the study first to view shared posts.</p> : null}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={onViewWall} disabled={!studyCompleted}>Open Wall</Button>
      </div>
    </div>
  );
}

function ShareModal({ image, results, selectedIds, searchQuery, onSearchQueryChange, onToggleUser, onClose, onShare, loading }) {
  if (!image) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[28px] bg-white p-6 shadow-2xl md:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="srip-eyebrow">Share with...</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Choose people to share this post with</h3>
          </div>
          <button type="button" onClick={onClose} className="text-sm font-medium text-slate-500 hover:text-slate-800">Close</button>
        </div>
        <div className="mt-5 space-y-4">
          <input className="srip-input" placeholder="Search by name or email" value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} />
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-3">
            {results.length === 0 ? <p className="p-2 text-sm text-slate-500">No matching participants found.</p> : null}
            {results.map((user) => {
              const selected = selectedIds.includes(user.user_id);
              const online = user.online ?? isOnline(user.last_active);
              return (
                <button key={user.user_id} type="button" onClick={() => onToggleUser(user.user_id)} className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm transition ${selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                  <span>
                    <span className="block font-semibold">{user.name || "Unnamed participant"}{user.roll_no ? ` (${user.roll_no})` : ""}</span>
                    <span className="block text-xs opacity-80">{user.email}</span>
                    <span className="mt-1 block text-xs opacity-80">{online ? "● Online" : user.presence || "Offline"}</span>
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-[0.2em]">{selected ? "Selected" : "Add"}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-500">{selectedIds.length} selected</p>
            <Button disabled={loading || selectedIds.length === 0} onClick={onShare}>{loading ? "Sharing..." : `Share with ${selectedIds.length} people`}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpotCheckPage({ spotCheckImage, loading, error, onRetry, onComplete }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [pendingTiming, setPendingTiming] = useState(null);
  const mountedAtRef = useRef(Date.now());
  const imageLoadedAtRef = useRef(null);
  const labelHoverStartRef = useRef(null);
  const labelHoverMsRef = useRef(0);

  // Same back-block pattern as the feed: once you've answered the spot
  // check, you cannot navigate back into the 10-image feed.
  useEffect(() => {
    const blockBack = () => window.history.pushState(null, "", window.location.href);
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", blockBack);
    return () => window.removeEventListener("popstate", blockBack);
  }, []);

  useEffect(() => {
    mountedAtRef.current = Date.now();
    imageLoadedAtRef.current = null;
    labelHoverStartRef.current = null;
    labelHoverMsRef.current = 0;
    setAnswer(null);
    setPendingTiming(null);
    setImageFailed(false);
  }, [spotCheckImage?.image_id]);

  const handleImageLoad = () => {
    imageLoadedAtRef.current = Date.now();
  };

  const handleImageMouseMove = (event) => {
    const labelPosition = spotCheckImage?.label_position;
    if (!labelPosition || labelPosition === "none") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const inLabelArea =
      (labelPosition === "topleft" && x < 0.3 && y < 0.3) ||
      (labelPosition === "topright" && x > 0.7 && y < 0.3) ||
      (labelPosition === "bottomleft" && x < 0.3 && y > 0.7) ||
      (labelPosition === "bottomright" && x > 0.7 && y > 0.7);
    if (inLabelArea) {
      labelHoverStartRef.current = labelHoverStartRef.current || Date.now();
    } else if (labelHoverStartRef.current) {
      labelHoverMsRef.current += Date.now() - labelHoverStartRef.current;
      labelHoverStartRef.current = null;
    }
  };

  const handleImageMouseLeave = () => {
    if (labelHoverStartRef.current) {
      labelHoverMsRef.current += Date.now() - labelHoverStartRef.current;
      labelHoverStartRef.current = null;
    }
  };

  const handleAnswer = (value) => {
    if (answer !== null) return;
    const now = Date.now();
    const loadedAt = imageLoadedAtRef.current || mountedAtRef.current;
    if (labelHoverStartRef.current) {
      labelHoverMsRef.current += now - labelHoverStartRef.current;
      labelHoverStartRef.current = null;
    }
    setAnswer(value);
    setPendingTiming({
      participant_answer: value,
      response_time_ms: now - loadedAt,
      dwell_ms: now - loadedAt,
      image_load_time_ms: imageLoadedAtRef.current ? imageLoadedAtRef.current - mountedAtRef.current : null,
      label_hover_ms: labelHoverMsRef.current,
    });
  };

  const handleContinue = () => {
    if (!pendingTiming) return;
    onComplete(pendingTiming);
  };

  if (loading || !spotCheckImage) {
    return (
      <Panel className="mx-auto w-full max-w-2xl p-6 md:p-10">
        <Title eyebrow="Step 5 of 8" title="One more quick check" description="Loading your image..." />
        <div className="mt-8 flex flex-col items-center gap-4">
          <Spinner label={error || "Preparing image..."} />
          {error ? <Button onClick={onRetry}>Try again</Button> : null}
        </div>
      </Panel>
    );
  }

  return (
    <Panel className="mx-auto w-full max-w-2xl p-6 md:p-10">
      <Title
        eyebrow="Step 5 of 8"
        title="One more quick check"
        description="Look at the image below, then answer the question. You will not be able to go back to the feed after this."
      />
      <div className="srip-feed-card relative mt-6 overflow-hidden">
        <div className="space-y-4 p-4 md:p-5">
          <div className="overflow-hidden rounded-[22px] bg-slate-100">
            {imageFailed ? (
              <div className="flex aspect-[4/3] items-center justify-center rounded-[22px] bg-slate-200 px-4 text-center text-sm font-medium text-slate-600">
                {spotCheckImage.category_id}
              </div>
            ) : (
              <div className="aspect-[4/3] w-full bg-slate-100 p-3">
                <img
                  src={spotCheckImage.image_url}
                  alt={spotCheckImage.feed_caption || "Spot check image"}
                  className="h-full w-full rounded-[18px] object-contain"
                  data-image-id={spotCheckImage.image_id}
                  onLoad={handleImageLoad}
                  onMouseMove={handleImageMouseMove}
                  onMouseLeave={handleImageMouseLeave}
                  onError={() => setImageFailed(true)}
                />
              </div>
            )}
          </div>

          <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Can you spot a label in this image?</p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                disabled={answer !== null}
                onClick={() => handleAnswer(true)}
                className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  answer === true ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                Yes
              </button>
              <button
                type="button"
                disabled={answer !== null}
                onClick={() => handleAnswer(false)}
                className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  answer === false ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                No
              </button>
            </div>
          </div>

          {answer !== null ? (
            <div className="flex justify-end">
              <Button onClick={handleContinue}>Continue -&gt;</Button>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function AwarenessPage({ awarenessText, setAwarenessText, onContinue }) {
  const [error, setError] = useState("");
  const handleContinue = () => {
    if (!awarenessText.trim()) { setError("Please write your answer before continuing."); return; }
    setError("");
    onContinue();
  };

  return (
    <Panel className="mx-auto w-full max-w-4xl p-6 md:p-10">
      <Title eyebrow="Step 6 of 8" title="One last question" description="Before you finish, please answer the question below." />
      <div className="mt-8 rounded-[24px] border border-slate-200 bg-slate-50 p-5">
        <label className="text-sm font-semibold text-slate-900">What do you think was the main purpose of this study? <span className="text-red-500">*</span></label>
        <textarea className="srip-input mt-3 min-h-32" value={awarenessText} onChange={(event) => { setAwarenessText(event.target.value); if (event.target.value.trim()) setError(""); }} placeholder="Write a short answer (required)" />
        {error ? <p className="mt-2 text-sm font-medium text-red-600">{error}</p> : null}
      </div>
      <div className="mt-6 flex justify-end">
        <Button onClick={handleContinue}>Continue -&gt;</Button>
      </div>
    </Panel>
  );
}

function PolicyPage({ policy, setPolicy, onSubmit, submitting }) {
  return (
    <Panel className="mx-auto w-full max-w-4xl p-6 md:p-10">
      <Title eyebrow="Step 7 of 8" title="Almost done!" description="You've completed all the tasks. Click Submit to save your responses and finish the study." />
      <div className="mt-8 flex justify-end">
        <Button disabled={submitting} onClick={onSubmit}>
          {submitting ? <span className="flex items-center gap-3"><Spinner label="Saving your responses..." /></span> : "Submit Survey →"}
        </Button>
      </div>
    </Panel>
  );
}

function ThankYouPage({ onContinueWall, onDone }) {
  return (
    <Panel className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center gap-6 px-8 py-16 text-center md:px-10 md:py-20">
      <p className="text-2xl font-semibold tracking-tight text-slate-950 md:text-3xl">Thank you for participating!</p>
      <p className="text-sm text-slate-600">Your responses have been recorded.</p>
      <div className="text-slate-400">─────────────────────────────────────────</div>
      <div className="flex flex-col gap-3 sm:flex-row">
        {onContinueWall ? <Button onClick={onContinueWall}>Browse Community Wall →</Button> : null}
        <Button variant="secondary" onClick={onDone}>Done</Button>
      </div>
    </Panel>
  );
}

function AttentionCheckCard({ response, onVerdict }) {
  return (
    <article className="srip-feed-card overflow-hidden">
      <div className="space-y-4 p-4 md:p-5">
        <div className="flex aspect-[4/3] items-center justify-center rounded-[22px] bg-indigo-600 px-6 text-center text-white">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-100">Attention Check</p>
            <p className="mt-4 text-lg font-semibold leading-8">Please select &quot;AI Modified&quot; to confirm you are reading carefully.</p>
          </div>
        </div>
        <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => onVerdict(ATTENTION_CHECK_ID, "real", "")} className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${response.verdict === "real" ? "border-slate-900 bg-slate-100 text-slate-900" : "border-slate-200 bg-white text-slate-700"}`}>
              📷 Real
            </button>
            <button type="button" onClick={() => onVerdict(ATTENTION_CHECK_ID, "ai_modified", "")} className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${response.verdict === "ai_modified" ? "border-slate-900 bg-slate-100 text-slate-900" : "border-slate-200 bg-white text-slate-700"}`}>
              🤖 AI Modified
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function StudyFeedCard({
  item,
  index,
  response,
  onVerdict,
  onLikeToggle,
  onShareClick,
  onReasonChange,
  onFirstScroll,
  showHint,
  firstHintDismissed,
  onImageLoad,
  onImageMouseMove,
  onImageWheel,
  onNextPost,
  showNextPost,
  onImageMouseLeave,
  cardRef
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const words = wordCount(response.reason || "");
  const overLimit = words > 10;
  const avatarLabel = item.feed_source_tag.replace("@", "").charAt(0).toUpperCase();
  const avatarColor = hashColor(item.feed_source_tag || item.category_id);

  return (
    <article ref={cardRef} data-card-id={item.image_id} className="srip-feed-card relative overflow-hidden">
      {index === 0 && showHint && !firstHintDismissed ? (
        <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full bg-slate-900/90 px-3 py-2 text-xs font-semibold text-white shadow-lg">
          <span className="mr-2 inline-block animate-bounce">↓</span> Scroll to explore
        </div>
      ) : null}
      <div className="space-y-4 p-4 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white" style={{ backgroundColor: avatarColor }}>
              {avatarLabel}
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">{item.feed_source_tag}</p>
              <p className="text-xs text-slate-500">{`${Math.max(2, 4 + index * 3)}m`}</p>
            </div>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{item.category_id}</span>
        </div>

        <div className="overflow-hidden rounded-[22px] bg-slate-100">
          {imageFailed ? (
            <div className="flex aspect-[4/3] items-center justify-center rounded-[22px] bg-slate-200 px-4 text-center text-sm font-medium text-slate-600">
              {item.category_id}
            </div>
          ) : (
            <div className="aspect-[4/3] w-full bg-slate-100 p-3">
              <img
                src={item.image_url}
                alt={item.feed_caption}
                className="h-full w-full rounded-[18px] object-contain"
                loading="lazy"
                data-image-id={item.image_id}
                onLoad={() => onImageLoad?.(item.image_id)}
                onMouseMove={(event) => onImageMouseMove?.(event, item.image_id, item.label_position)}
                onWheel={() => onImageWheel?.(item.image_id)}
                onMouseLeave={() => onImageMouseLeave?.(item.image_id)}
                onError={() => setImageFailed(true)}
              />
            </div>
          )}
        </div>

        <p className="text-sm leading-7 text-slate-700">{item.feed_caption}</p>

        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => onLikeToggle(item.image_id)}
            className={`rounded-full border px-4 py-2 transition ${response.liked ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
          >
            👍 {response.liked ? "Liked" : "Like"}
          </button>
          <button
            type="button"
            onClick={() => onShareClick(item)}
            className={`rounded-full border px-4 py-2 transition ${response.shared ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
          >
            📤 {response.shared ? `Shared${response.shared_with_count ? ` (${response.shared_with_count})` : ""}` : "Share"}
          </button>
        </div>

        <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-4 transition-opacity duration-300">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Is this image real or AI?</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => onVerdict(item.image_id, "real", response.reason || "")}
              className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${response.verdict === "real" ? "border-slate-900 bg-slate-100 text-slate-900" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`}
            >
              📷 Real
            </button>
            <button
              type="button"
              onClick={() => onVerdict(item.image_id, "ai_modified", response.reason || "")}
              className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${response.verdict === "ai_modified" ? "border-slate-900 bg-slate-100 text-slate-900" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`}
            >
              🤖 AI Modified
            </button>
          </div>

          <div className={`mt-4 overflow-hidden transition-all duration-300 ${response.verdict === "ai_modified" ? "max-h-72 opacity-100" : "max-h-0 opacity-0"}`}>
            <div className="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
              <label className="text-sm font-semibold text-slate-900">Why do you think it is AI modified? (max 10 words)</label>
              <textarea
                value={response.reason || ""}
                onChange={(event) => onReasonChange(item.image_id, event.target.value)}
                rows={3}
                className={`w-full resize-none rounded-2xl border px-4 py-3 text-sm outline-none transition ${overLimit ? "border-red-500 text-red-700" : "border-slate-200 focus:border-slate-900"}`}
                placeholder="Type a short reason"
              />
              <div className="flex items-center justify-between text-xs">
                <span className={overLimit ? "font-semibold text-red-600" : "text-slate-500"}>{words} / 10 words</span>
              </div>
            </div>
          </div>

          {showNextPost && response.verdict ? (
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" onClick={() => onNextPost(item.image_id)}>Next Post →</Button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function StudyFeedPage({ feedImages, responses, onUpdateResponse, onComplete, loading, error, onRetry, sessionReady, sessionId, token, onShareStateChange }) {
  const feedRef = useRef(null);
  const dwellState = useRef({});
  const rtState = useRef({});
  const observerRef = useRef(null);
  const labelHoverStart = useRef({});
  const labelHoverMs = useRef({});
  const verdictChanges = useRef({});
  const cardRefs = useRef({});
  const lastScrollY = useRef(window.scrollY);
  const scrollDir = useRef("down");
  const displayItems = useMemo(() => buildFeedDisplayItems(feedImages), [feedImages]);
  const [showHint, setShowHint] = useState(true);
  const [firstHintDismissed, setFirstHintDismissed] = useState(false);
  const [shareModal, setShareModal] = useState({ open: false, image: null });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [shareLoading, setShareLoading] = useState(false);

  useEffect(() => {
    const blockBack = () => window.history.pushState(null, "", window.location.href);
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", blockBack);
    return () => window.removeEventListener("popstate", blockBack);
  }, []);

  useEffect(() => {
    if (!shareModal.open || !token) return undefined;
    const timeout = window.setTimeout(() => {
      (async () => {
        try {
          const response = await fetch(`/api/users/search?q=${encodeURIComponent(searchQuery)}`, {
            headers: authHeaders(token)
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.detail || "Could not search participants.");
          }
          setSearchResults(data.results || []);
        } catch {
          setSearchResults([]);
        }
      })();
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery, shareModal.open, token]);

  useEffect(() => {
    dwellState.current = {};
    rtState.current = {};
    labelHoverStart.current = {};
    labelHoverMs.current = {};
    verdictChanges.current = {};
  }, [feedImages]);

  useEffect(() => {
    const onScroll = () => {
      const currentY = window.scrollY;
      scrollDir.current = currentY < lastScrollY.current ? "up" : "down";
      lastScrollY.current = currentY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!feedImages.length) return undefined;
    const root = feedRef.current;
    if (!root) return undefined;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const now = Date.now();
        entries.forEach((entry) => {
          const imageId = entry.target.dataset.imageId;
          if (!imageId) return;
          if (!dwellState.current[imageId]) {
            dwellState.current[imageId] = {
              totalMs: 0,
              enteredAt: null,
              verdictSubmitted: false,
              revisitCount: 0,
              revisitScrollUp: 0,
              revisitScrollDown: 0,
              revisitPostVerdict: 0,
              revisitScrollUpPost: 0,
              revisitScrollDownPost: 0,
              hasLeftOnce: false,
              hasLeftOncePost: false
            };
          }
          const state = dwellState.current[imageId];
          const visibleEnough = entry.isIntersecting && entry.intersectionRatio >= 0.5;
          if (visibleEnough) {
            if (!rtState.current[imageId]?.firstSeenAt) {
              const firstSeenAt = Date.now();
              rtState.current[imageId] = { firstSeenAt };
              onUpdateResponse(imageId, { firstSeenAt });
            }
            if (!state.verdictSubmitted && !state.enteredAt) {
              state.enteredAt = now;
            }
            if (state.hasLeftOnce) {
              state.revisitCount += 1;
              if (scrollDir.current === "up") state.revisitScrollUp += 1;
              else state.revisitScrollDown += 1;
              state.hasLeftOnce = false;
            }
            if (state.hasLeftOncePost && state.verdictSubmitted) {
              state.revisitPostVerdict += 1;
              if (scrollDir.current === "up") state.revisitScrollUpPost += 1;
              else state.revisitScrollDownPost += 1;
              state.hasLeftOncePost = false;
              onUpdateResponse(imageId, {
                revisits_post_verdict: state.revisitPostVerdict,
                revisit_scroll_up_post: state.revisitScrollUpPost,
                revisit_scroll_down_post: state.revisitScrollDownPost,
              });
            }
          } else {
            if (state.enteredAt && !state.verdictSubmitted) {
              state.totalMs += now - state.enteredAt;
              state.enteredAt = null;
              state.hasLeftOnce = true;
            }
            if (state.verdictSubmitted) {
              state.hasLeftOncePost = true;
            }
          }
        });
      },
      { threshold: 0.5, rootMargin: "0px" }
    );

    root.querySelectorAll("[data-image-id]").forEach((element) => observerRef.current.observe(element));
    return () => {
      observerRef.current?.disconnect();
    };
  }, [feedImages, onUpdateResponse]);

  useEffect(() => {
    if (!showHint || !feedImages.length) return undefined;
    const hide = () => {
      if (window.scrollY > 0) {
        setShowHint(false);
        setFirstHintDismissed(true);
        window.removeEventListener("scroll", hide);
      }
    };
    window.addEventListener("scroll", hide, { passive: true });
    return () => window.removeEventListener("scroll", hide);
  }, [feedImages.length, showHint]);

  const recordVerdict = (imageId, verdict, reasonText) => {
    const now = Date.now();
    const state = dwellState.current[imageId];
    if (state?.enteredAt && !state.verdictSubmitted) {
      state.totalMs += now - state.enteredAt;
      state.enteredAt = null;
    }
    const prevVerdict = responses[imageId]?.verdict ?? null;
    const isChange = prevVerdict !== null && prevVerdict !== verdict;
    if (!verdictChanges.current[imageId]) verdictChanges.current[imageId] = { changed: false, count: 0 };
    if (isChange) {
      verdictChanges.current[imageId].changed = true;
      verdictChanges.current[imageId].count += 1;
    }
    if (state) {
      state.verdictSubmitted = true;
    }

    const rt = rtState.current[imageId];
    const firstSeenAt = rt?.firstSeenAt || responses[imageId]?.firstSeenAt;
    const responseTimeMs = firstSeenAt ? now - firstSeenAt : null;
    if (labelHoverStart.current[imageId]) {
      labelHoverMs.current[imageId] = (labelHoverMs.current[imageId] || 0) + (now - labelHoverStart.current[imageId]);
      labelHoverStart.current[imageId] = null;
    }
    onUpdateResponse(imageId, {
      verdict,
      reason: reasonText,
      dwell_ms: state?.totalMs || 0,
      response_time_ms: responseTimeMs,
      scroll_revisits: state?.revisitCount || 0,
      revisit_scroll_up: state?.revisitScrollUp || 0,
      revisit_scroll_down: state?.revisitScrollDown || 0,
      revisits_post_verdict: state?.revisitPostVerdict || 0,
      revisit_scroll_up_post: state?.revisitScrollUpPost || 0,
      revisit_scroll_down_post: state?.revisitScrollDownPost || 0,
      verdict_changed: verdictChanges.current[imageId]?.changed || false,
      verdict_change_count: verdictChanges.current[imageId]?.count || 0,
      label_hover_ms: labelHoverMs.current[imageId] || responses[imageId]?.label_hover_ms || 0,
      zoom_count: responses[imageId]?.zoom_count || 0,
      image_load_time_ms: responses[imageId]?.image_load_time_ms ?? null,
      firstSeenAt: firstSeenAt || null
    });
  };

  const handleImageLoad = (imageId) => {
    const startedAt = responses[imageId]?.image_load_started_at;
    if (!startedAt) return;
    onUpdateResponse(imageId, { image_load_time_ms: Date.now() - startedAt });
  };

  const handleImageMouseMove = (event, imageId, labelPosition) => {
    if (!labelPosition || labelPosition === "none") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const inLabelArea =
      (labelPosition === "topleft" && x < 0.3 && y < 0.3) ||
      (labelPosition === "topright" && x > 0.7 && y < 0.3) ||
      (labelPosition === "bottomleft" && x < 0.3 && y > 0.7) ||
      (labelPosition === "bottomright" && x > 0.7 && y > 0.7);
    if (inLabelArea) {
      labelHoverStart.current[imageId] = labelHoverStart.current[imageId] || Date.now();
    } else if (labelHoverStart.current[imageId]) {
      labelHoverMs.current[imageId] = (labelHoverMs.current[imageId] || 0) + (Date.now() - labelHoverStart.current[imageId]);
      labelHoverStart.current[imageId] = null;
      onUpdateResponse(imageId, { label_hover_ms: labelHoverMs.current[imageId] || 0 });
    }
  };

  const handleImageMouseLeave = (imageId) => {
    if (labelHoverStart.current[imageId]) {
      labelHoverMs.current[imageId] = (labelHoverMs.current[imageId] || 0) + (Date.now() - labelHoverStart.current[imageId]);
      labelHoverStart.current[imageId] = null;
      onUpdateResponse(imageId, { label_hover_ms: labelHoverMs.current[imageId] || 0 });
    }
  };

  const handleImageWheel = (imageId) => {
    const current = responses[imageId]?.zoom_count || 0;
    onUpdateResponse(imageId, { zoom_count: current + 1 });
  };

  const goToNextPost = (imageId) => {
    const imageIds = displayItems.filter((entry) => entry.kind === "image").map((entry) => entry.image.image_id);
    const currentIndex = imageIds.indexOf(imageId);
    const nextId = imageIds[currentIndex + 1];
    if (!nextId) return;
    window.setTimeout(() => {
      cardRefs.current[nextId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 500);
  };

  const handleLikeToggle = (imageId) => {
    onUpdateResponse(imageId, { liked: !responses[imageId]?.liked });
  };

  const handleOpenShare = (image) => {
    setShareModal({ open: true, image });
    setSearchQuery("");
    setSearchResults([]);
    setSelectedUserIds([]);
  };

  const submitShare = async () => {
    if (!shareModal.image || selectedUserIds.length === 0) return;
    setShareLoading(true);
    try {
      const response = await fetch("/api/social/share", {
        method: "POST",
        headers: authHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          image_id: shareModal.image.image_id,
          image_url: shareModal.image.image_url,
          feed_caption: shareModal.image.feed_caption,
          feed_source_tag: shareModal.image.feed_source_tag,
          category_id: shareModal.image.category_id,
          share_with_user_ids: selectedUserIds,
          sharer_verdict: responses[shareModal.image.image_id]?.verdict || null
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Share failed.");
      }
      onUpdateResponse(shareModal.image.image_id, {
        shared: true,
        shared_with_count: data.shared_with_count || selectedUserIds.length,
        share_recipients: selectedUserIds.join(","),
        community_wall_likes: responses[shareModal.image.image_id]?.community_wall_likes || 0,
        shared_post_id: data.post_id || null
      });
      onShareStateChange?.(data.shared_with_count || selectedUserIds.length);
      setShareModal({ open: false, image: null });
    } catch (error) {
      alert(error instanceof Error ? error.message : "Share failed.");
    } finally {
      setShareLoading(false);
    }
  };

  const completionReady = useMemo(
    () =>
      feedImages.length > 0 &&
      feedImages.every((item) => responses[item.image_id]?.verdict) &&
      Boolean(responses[ATTENTION_CHECK_ID]?.verdict),
    [feedImages, responses]
  );

  if (loading) {
    return <Panel className="mx-auto w-full max-w-4xl p-8 text-center"><Spinner label="Loading your session" /></Panel>;
  }

  if (error) {
    return (
      <Panel className="mx-auto w-full max-w-4xl p-8 text-center">
        <Title eyebrow="Session error" title="We could not start the feed" description={error} />
        <div className="mt-6">
          <Button variant="secondary" onClick={onRetry}>Retry</Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-20 pt-4 md:px-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="srip-eyebrow">Live feed</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Scroll naturally and judge each post</h2>
          <p className="mt-2 text-sm text-slate-500">Tell us whether it&apos;s real or AI-modified, and feel free to like and share posts with peers and friends who are also scrolling the feed.</p>
        </div>
        <div className="hidden rounded-full border border-slate-200 bg-white px-4 py-2 text-xs text-slate-500 md:block">Session {sessionReady ? sessionId.slice(0, 8) : "pending"}</div>
      </div>

      <div ref={feedRef} className="space-y-6">
        {displayItems.map((entry, index) => {
          if (entry.kind === "attention") {
            return (
              <AttentionCheckCard
                key={ATTENTION_CHECK_ID}
                response={responses[ATTENTION_CHECK_ID] || buildResponse()}
                onVerdict={recordVerdict}
              />
            );
          }
          const item = entry.image;
          const imageIndex = entry.feedIndex;
          const imageIds = displayItems.filter((row) => row.kind === "image").map((row) => row.image.image_id);
          const isLastImage = imageIds[imageIds.length - 1] === item.image_id;
          return (
            <StudyFeedCard
              key={item.image_id}
              item={item}
              index={imageIndex}
              response={responses[item.image_id] || buildResponse()}
              onVerdict={recordVerdict}
              onLikeToggle={handleLikeToggle}
              onShareClick={handleOpenShare}
              onReasonChange={(imageId, text) => onUpdateResponse(imageId, { reason: text })}
              onImageLoad={handleImageLoad}
              onImageMouseMove={handleImageMouseMove}
              onImageMouseLeave={handleImageMouseLeave}
              onImageWheel={handleImageWheel}
              onNextPost={goToNextPost}
              showNextPost={!isLastImage}
              cardRef={(node) => {
                cardRefs.current[item.image_id] = node;
              }}
              showHint={showHint}
              firstHintDismissed={firstHintDismissed}
              onFirstScroll={() => {
                setShowHint(false);
                setFirstHintDismissed(true);
              }}
            />
          );
        })}
      </div>

      <div className="mt-8 flex flex-col items-center gap-2">
        <div title={!completionReady ? "Please respond to all images before continuing" : undefined}>
          <Button disabled={!completionReady} onClick={onComplete}>Continue →</Button>
        </div>
        {!completionReady ? (
          <p className="text-xs text-slate-400">Please select Real or AI Modified for every image before continuing</p>
        ) : null}
      </div>

      {shareModal.open ? (
        <ShareModal
          image={shareModal.image}
          results={searchResults}
          selectedIds={selectedUserIds}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onToggleUser={(userId) => setSelectedUserIds((prev) => (prev.includes(userId) ? prev.filter((value) => value !== userId) : [...prev, userId]))}
          onClose={() => setShareModal({ open: false, image: null })}
          onShare={submitShare}
          loading={shareLoading}
        />
      ) : null}
    </div>
  );
}

function CommunityWallCard({ post, onLike, onReply }) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <article className="srip-feed-card overflow-hidden">
      <div className="space-y-4 p-4 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">{post.shared_by_name || post.shared_by_email || "A participant"} shared this</p>
            <p className="text-xs text-slate-500">{post.feed_source_tag || post.shared_at}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{post.like_count || 0} likes</span>
        </div>
        <div className="overflow-hidden rounded-[22px] bg-slate-100">
          {imageFailed ? (
            <div className="flex aspect-[4/3] items-center justify-center rounded-[22px] bg-slate-200 px-4 text-center text-sm font-medium text-slate-600">
              {post.feed_caption}
            </div>
          ) : (
            <div className="aspect-[4/3] w-full bg-slate-100 p-3">
              <img src={post.image_url} alt={post.feed_caption} className="h-full w-full rounded-[18px] object-contain" loading="lazy" onError={() => setImageFailed(true)} />
            </div>
          )}
        </div>
        <p className="text-sm leading-7 text-slate-700">{post.feed_caption}</p>
        <div className="flex items-center gap-3 text-sm">
          <button type="button" onClick={() => onLike(post.post_id)} className={`rounded-full border px-4 py-2 transition ${post.liked_by_me ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
            ❤️ {post.like_count || 0}
          </button>
          <button type="button" onClick={() => onReply && onReply(post.shared_by_user_id)} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-slate-700 hover:bg-slate-50">💬 Reply</button>
        </div>
      </div>
    </article>
  );
}

function CommunityWallPage({ token, wallPosts, loading, error, onRetry, onLike, onRefresh, onReply }) {
  if (loading) {
    return <Panel className="mx-auto w-full max-w-4xl p-8 text-center"><Spinner label="Loading community wall" /></Panel>;
  }

  if (error) {
    return (
      <Panel className="mx-auto w-full max-w-4xl p-8 text-center">
        <Title eyebrow="Community wall" title="We could not load the wall" description={error} />
        <div className="mt-6">
          <Button variant="secondary" onClick={onRetry}>Retry</Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-20 pt-4 md:px-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="srip-eyebrow">Community Wall</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Posts shared by study participants</h2>
        </div>
      </div>
      <div className="space-y-6">
        {wallPosts.length === 0 ? <Panel className="p-6 text-sm text-slate-600">No shared posts yet.</Panel> : wallPosts.map((post) => <CommunityWallCard key={post.post_id} post={post} onLike={onLike} onReply={onReply} />)}
      </div>
    </div>
  );
}

function ExitScreen() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-16">
      <Panel className="w-full p-8 md:p-10">
        <Title eyebrow="Study closed" title="You chose not to participate." description="No survey data was collected. You can close this window." />
      </Panel>
    </div>
  );
}

function readStoredAuth() {
  try {
    const token = localStorage.getItem("srip_token") || "";
    const user = JSON.parse(localStorage.getItem("srip_user") || "null");
    return { token, user };
  } catch {
    return { token: "", user: null };
  }
}

export default function App() {
  const [page, setPage] = useState(1);
  const [consentDeclined, setConsentDeclined] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [authUser, setAuthUser] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [feedImages, setFeedImages] = useState([]);
  const [responses, setResponses] = useState({});
  const [participant, setParticipant] = useState({ name: "", email: "", roll_no: "", age: "", gender: "", ai_frequency: null, ai_confidence: null });
  const [spotCheckImage, setSpotCheckImage] = useState(null);
  const [spotCheckResult, setSpotCheckResult] = useState(null);
  const [spotCheckError, setSpotCheckError] = useState("");
  const [awarenessText, setAwarenessText] = useState("");
  const [policy, setPolicy] = useState({ responsibility: "", legal_requirement: null });
  const [metrics, setMetrics] = useState(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [studyCompleted, setStudyCompleted] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [wallPosts, setWallPosts] = useState([]);
  const [wallLoading, setWallLoading] = useState(false);
  const [wallError, setWallError] = useState("");
  const [shareToast, setShareToast] = useState("");
  const [messageUnreadCount, setMessageUnreadCount] = useState(0);
  const [wallOnlyMode, setWallOnlyMode] = useState(false);
  const [isDevMode, setIsDevMode] = useState(false);
  const [replyTargetId, setReplyTargetId] = useState(null);
  const surveyStartRef = useRef(Date.now());
  const consentStartRef = useRef(null);
  const maxScrollDepthRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { token, user } = readStoredAuth();
      if (!token) {
        if (!cancelled) setAuthReady(true);
        return;
      }
      try {
        const response = await fetch("/api/auth/me", { headers: authHeaders(token) });
        if (!response.ok) throw new Error("Session expired");
        const data = await response.json();
        if (cancelled) return;
        setAuthToken(token);
        setAuthUser(data);
        setStudyCompleted(Boolean(data.study_completed));
        setWallOnlyMode(Boolean(data.study_completed));
        if (data.study_completed) setPage(9);
        setParticipant((prev) => ({
          ...prev,
          name: data.name || user?.name || prev.name,
          email: data.email || user?.email || prev.email,
          roll_no: data.roll_no || prev.roll_no
        }));
      } catch {
        localStorage.removeItem("srip_token");
        localStorage.removeItem("srip_user");
        if (!cancelled) {
          setAuthToken("");
          setAuthUser(null);
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authToken || page !== 4 || feedImages.length > 0) return undefined;
    let cancelled = false;
    (async () => {
      setLoadingSession(true);
      setSessionError("");
      try {
        const response = await fetch("/api/session", { headers: authHeaders(authToken) });
        if (!response.ok) throw new Error(`Session request failed (${response.status})`);
        const data = await response.json();
        if (cancelled) return;
        setSessionId(data.session_id);
        setFeedImages(data.images || []);
        const initialResponses = Object.fromEntries(
          (data.images || []).map((image) => [image.image_id, { ...buildResponse(), image_load_started_at: Date.now() }])
        );
        initialResponses[ATTENTION_CHECK_ID] = buildResponse();
        setResponses(initialResponses);
      } catch (error) {
        if (!cancelled) setSessionError(error instanceof Error ? error.message : "Failed to start session.");
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authToken, feedImages.length, page]);

  // Single post-feed "can you spot a label" test image — fetched once the
  // participant reaches that page, deterministic per session so a reload
  // can't reroll a different image.
  useEffect(() => {
    if (!authToken || !sessionId || page !== 5 || spotCheckImage) return undefined;
    let cancelled = false;
    (async () => {
      setSpotCheckError("");
      try {
        const response = await fetch(`/api/spot-image?session_id=${encodeURIComponent(sessionId)}`, { headers: authHeaders(authToken) });
        if (!response.ok) throw new Error(`Spot-check image request failed (${response.status})`);
        const data = await response.json();
        if (cancelled) return;
        setSpotCheckImage(data.image || null);
      } catch (error) {
        if (!cancelled) setSpotCheckError(error instanceof Error ? error.message : "Failed to load image.");
      }
    })();
    return () => { cancelled = true; };
  }, [authToken, sessionId, page, spotCheckImage]);

  useEffect(() => {
    if (!authToken) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/social/notifications", { headers: authHeaders(authToken) });
        const data = await response.json();
        if (!response.ok) return;
        if (cancelled) return;
        setNotifications(data.notifications || []);
        setUnreadCount(data.unread_count || 0);
      } catch {
        // ignore polling errors
      }
    };
    poll();
    const intervalId = window.setInterval(poll, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [authToken]);

  useEffect(() => {
    if (!authToken || studyCompleted) return undefined;
    const device = getDeviceInfo();
    const sendHeartbeat = () => {
      fetch("/api/auth/heartbeat", {
        method: "POST",
        headers: authHeaders(authToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ device_info: device.device_info })
      }).catch(() => {});
    };
    sendHeartbeat();
    const intervalId = window.setInterval(sendHeartbeat, 60000);
    return () => window.clearInterval(intervalId);
  }, [authToken, studyCompleted]);

  useEffect(() => {
    if (!authToken || !studyCompleted) return undefined;
    const poll = async () => {
      try {
        const response = await fetch("/api/messages", { headers: authHeaders(authToken) });
        const data = await response.json();
        if (response.ok) setMessageUnreadCount(data.unread_count || 0);
      } catch {
        // ignore
      }
    };
    poll();
    const intervalId = window.setInterval(poll, 15000);
    return () => window.clearInterval(intervalId);
  }, [authToken, studyCompleted]);

  useEffect(() => {
    if (page !== 4) return undefined;
    const onScroll = () => {
      const scrolled = window.scrollY + window.innerHeight;
      const total = document.body.scrollHeight || 1;
      maxScrollDepthRef.current = Math.max(maxScrollDepthRef.current, scrolled / total);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [page]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!sessionId || studyCompleted || page >= 8) return;
      const payload = JSON.stringify({
        session_id: sessionId,
        dropped_at_page: page,
        images_seen: Object.values(responses).filter((response) => response.verdict).length
      });
      navigator.sendBeacon("/api/dropout", new Blob([payload], { type: "application/json" }));
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [page, responses, sessionId, studyCompleted]);

  useEffect(() => {
    if (!authToken || page !== 9 || !studyCompleted) return undefined;
    let cancelled = false;
    (async () => {
      setWallLoading(true);
      setWallError("");
      try {
        const response = await fetch("/api/social/wall", { headers: authHeaders(authToken) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Could not load community wall.");
        if (!cancelled) setWallPosts(data.posts || []);
      } catch (error) {
        if (!cancelled) setWallError(error instanceof Error ? error.message : "Could not load community wall.");
      } finally {
        if (!cancelled) setWallLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken, page, studyCompleted]);

  useEffect(() => {
    if (!shareToast) return undefined;
    const timeoutId = window.setTimeout(() => setShareToast(""), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [shareToast]);

  const updateResponse = (imageId, patch) => {
    setResponses((prev) => ({ ...prev, [imageId]: { ...buildResponse(), ...(prev[imageId] || buildResponse()), ...patch } }));
  };

  const goTo = (nextPage) => setPage(nextPage);

  const handleAuthSuccess = ({ token, user }) => {
    setAuthToken(token);
    setAuthUser(user);
    setStudyCompleted(false);
    setWallOnlyMode(false);
    localStorage.setItem("srip_token", token);
    localStorage.setItem("srip_user", JSON.stringify(user));
    setParticipant((prev) => ({
      ...prev,
      name: user.name || prev.name,
      email: user.email || prev.email,
      roll_no: user.roll_no || prev.roll_no,
    }));
    setPage(1);
    surveyStartRef.current = Date.now();
    consentStartRef.current = null;
  };

  const handleCompletedStudyLogin = ({ token, user }) => {
    setAuthToken(token);
    setAuthUser(user);
    setStudyCompleted(true);
    setWallOnlyMode(true);
    localStorage.setItem("srip_token", token);
    localStorage.setItem("srip_user", JSON.stringify(user));
    setPage(9);
  };

  const clearAuth = () => {
    if (sessionId && !studyCompleted && page < 8) {
      const payload = JSON.stringify({
        session_id: sessionId,
        dropped_at_page: page,
        images_seen: Object.values(responses).filter((response) => response.verdict).length
      });
      navigator.sendBeacon("/api/dropout", new Blob([payload], { type: "application/json" }));
    }
    localStorage.removeItem("srip_token");
    localStorage.removeItem("srip_user");
    setAuthToken("");
    setAuthUser(null);
    setPage(1);
    setSessionId(null);
    setFeedImages([]);
    setResponses({});
    setSpotCheckImage(null);
    setSpotCheckResult(null);
    setSpotCheckError("");
    setAwarenessText("");
    setPolicy({ responsibility: "", legal_requirement: null });
    setMetrics(null);
    setStudyCompleted(false);
    setNotifications([]);
    setUnreadCount(0);
    setNotificationsOpen(false);
    setWallPosts([]);
    setWallError("");
    setShareToast("");
    setWallOnlyMode(false);
    setMessageUnreadCount(0);
  };

  const handleToggleNotifications = async () => {
    if (!authToken) return;
    if (!notificationsOpen && notifications.length > 0) {
      try {
        await fetch("/api/social/notifications/read", {
          method: "POST",
          headers: authHeaders(authToken, { "Content-Type": "application/json" }),
          body: JSON.stringify({ notification_ids: notifications.map((notification) => notification.notif_id || notification.id) })
        });
        setUnreadCount(0);
      } catch {
        // ignore read failures
      }
    }
    setNotificationsOpen((prev) => !prev);
  };

  const refreshWall = async () => {
    if (!authToken || !studyCompleted) return;
    try {
      const response = await fetch("/api/social/wall", { headers: authHeaders(authToken) });
      const data = await response.json();
      if (response.ok) setWallPosts(data.posts || []);
    } catch {
      // ignore refresh failures
    }
  };

  const handleLikeWallPost = async (postId) => {
    if (!authToken) return;
    try {
      const response = await fetch("/api/social/like", {
        method: "POST",
        headers: authHeaders(authToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ post_id: postId })
      });
      const data = await response.json();
      if (!response.ok) return;
      setWallPosts((prev) => prev.map((post) => (post.post_id === postId ? { ...post, liked_by_me: data.liked, like_count: data.like_count } : post)));
    } catch {
      // ignore like errors
    }
  };

  const handleShareStateChange = (recipientCount) => {
    setShareToast(`Shared with ${recipientCount} people ✓`);
  };

  const refreshNotifications = async () => {
    if (!authToken) return;
    try {
      const response = await fetch("/api/social/notifications", { headers: authHeaders(authToken) });
      const data = await response.json();
      if (response.ok) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unread_count || 0);
      }
    } catch {
      // ignore refresh failures
    }
  };

  const submitSurvey = async () => {
    if (!sessionId || !authToken || !authUser) return;
    setSubmitting(true);
    try {
      const device = getDeviceInfo();
      const attentionResponse = responses[ATTENTION_CHECK_ID];
      const payload = {
        session_id: sessionId,
        participant: { ...participant, age: Number(participant.age) },
        responses: feedImages.map((item, index) => {
          const state = responses[item.image_id] || buildResponse();
          return {
            image_id: item.image_id,
            category_id: item.category_id,
            category_folder: item.category_folder || "",
            image_type: item.image_type,
            is_ai: item.is_ai,
            label_size_pct: item.label_size_pct,
            label_position: item.label_position,
            label_type: item.label_type || "",
            participant_verdict: state.verdict,
            is_correct: item.is_ai ? state.verdict === "ai_modified" : state.verdict === "real",
            reason_text: state.reason || "",
            dwell_ms: state.dwell_ms || 0,
            response_time_ms: state.response_time_ms,
            liked: Boolean(state.liked),
            shared: Boolean(state.shared),
            shared_with_count: state.shared_with_count || 0,
            share_recipients: state.share_recipients || "",
            community_wall_likes: state.community_wall_likes || 0,
            scroll_revisits: state.scroll_revisits || 0,
            revisit_scroll_up: state.revisit_scroll_up || 0,
            revisit_scroll_down: state.revisit_scroll_down || 0,
            label_hover_ms: state.label_hover_ms || 0,
            zoom_count: state.zoom_count || 0,
            image_load_time_ms: state.image_load_time_ms,
            image_position_in_feed: index + 1,
            revisits_post_verdict: state.revisits_post_verdict || 0,
            revisit_scroll_up_post: state.revisit_scroll_up_post || 0,
            revisit_scroll_down_post: state.revisit_scroll_down_post || 0,
            verdict_changed: state.verdict_changed || false,
            verdict_change_count: state.verdict_change_count || 0
          };
        }),
        spot_check: spotCheckImage
          ? {
              image_id: spotCheckImage.image_id,
              category_id: spotCheckImage.category_id,
              category_folder: spotCheckImage.category_folder || "",
              image_type: spotCheckImage.image_type,
              is_ai: spotCheckImage.is_ai,
              label_size_pct: spotCheckImage.label_size_pct,
              label_position: spotCheckImage.label_position,
              label_type: spotCheckImage.label_type || "",
              participant_answer: spotCheckResult?.participant_answer ?? null,
              dwell_ms: spotCheckResult?.dwell_ms || 0,
              response_time_ms: spotCheckResult?.response_time_ms ?? null,
              image_load_time_ms: spotCheckResult?.image_load_time_ms ?? null,
              label_hover_ms: spotCheckResult?.label_hover_ms || 0,
            }
          : undefined,
        awareness_response: awarenessText,
        policy,
        total_time_ms: Date.now() - surveyStartRef.current,
        survey_start_time: consentStartRef.current || new Date(surveyStartRef.current).toISOString(),
        attention_check_passed: attentionResponse?.verdict === "ai_modified",
        max_scroll_depth_pct: maxScrollDepthRef.current,
        device,
        submitted_at: new Date().toISOString()
      };
      let response = await fetch("/api/submit", {
        method: "POST",
        headers: authHeaders(authToken, { "Content-Type": "application/json" }),
        body: JSON.stringify(payload)
      });
      // If token was invalidated (server restart / file corruption), re-verify and retry once
      if (response.status === 401) {
        const reauth = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: participant.email, otp: "__reauth__" })
        }).catch(() => null);
        // Reauth won't work without OTP — just surface a clear error
        const errorData = await response.json().catch(() => ({}));
        throw new Error("Your session expired. Please refresh the page and log in again — your responses are saved in this tab until you close it.");
      }
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Submission failed.");
      }
      const data = await response.json();
      setMetrics(data.metrics || null);
      setStudyCompleted(true);
      setPage(8);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const progress = { 1: 0, 2: 14, 3: 25, 4: 60, 5: 71, 6: 82, 7: 92, 8: 97, 9: 99, 10: 100 };

  if (consentDeclined) return <ExitScreen />;

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.64),_transparent_28%),linear-gradient(180deg,#f4f7fb_0%,#edf2f7_100%)] text-slate-900">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl items-center px-4 py-10 md:px-6 md:py-14">
          <Panel className="mx-auto w-full max-w-3xl p-8 text-center"><Spinner label="Checking your access" /></Panel>
        </div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.64),_transparent_28%),linear-gradient(180deg,#f4f7fb_0%,#edf2f7_100%)] text-slate-900">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl items-center px-4 py-10 md:px-6 md:py-14">
          <AuthPage onAuthenticated={handleAuthSuccess} onCompletedStudy={handleCompletedStudyLogin} onDevMode={() => setIsDevMode(true)} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.64),_transparent_28%),linear-gradient(180deg,#f4f7fb_0%,#edf2f7_100%)] text-slate-900">
      <ProgressBar value={progress[page] || 0} />
      <HeaderBar
        user={authUser}
        unreadCount={unreadCount}
        messageUnreadCount={messageUnreadCount}
        notificationsOpen={notificationsOpen}
        studyCompleted={studyCompleted}
        onToggleNotifications={handleToggleNotifications}
        onOpenMessages={() => setPage(10)}
        onOpenWall={() => setPage(9)}
        onLogout={clearAuth}
      />
      {notificationsOpen ? (
        <NotificationPopover
          notifications={notifications}
          studyCompleted={studyCompleted}
          onClose={() => setNotificationsOpen(false)}
          onViewWall={() => { setNotificationsOpen(false); setPage(9); }}
          onSelectNotification={() => {
            setNotificationsOpen(false);
            if (studyCompleted) setPage(9);
          }}
        />
      ) : null}
      {wallOnlyMode ? (
        <Panel className="mx-auto mb-6 w-full max-w-4xl p-4 text-sm text-slate-700">
          You have already completed this study. Your response has been recorded. You can browse the Community Wall below.
        </Panel>
      ) : null}
      {shareToast ? <div className="fixed bottom-6 right-6 z-50 rounded-full bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg">{shareToast}</div> : null}
      <div className="mx-auto flex min-h-screen w-full max-w-7xl items-start px-4 py-10 md:px-6 md:py-14">
        <AnimatePresence mode="wait">
          <motion.div key={page} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.25 }} className="w-full">
            {!wallOnlyMode && page === 1 ? <ConsentPage onAgree={() => { consentStartRef.current = new Date().toISOString(); goTo(2); }} onExit={() => setConsentDeclined(true)} /> : null}
            {!wallOnlyMode && page === 2 ? <DemographicsPage participant={participant} setParticipant={setParticipant} onContinue={() => goTo(3)} /> : null}
            {!wallOnlyMode && page === 3 ? <InstructionsPage onContinue={() => goTo(4)} /> : null}
            {!wallOnlyMode && page === 4 ? (
              <StudyFeedPage
                feedImages={feedImages}
                responses={responses}
                onUpdateResponse={updateResponse}
                onComplete={() => goTo(5)}
                loading={loadingSession}
                error={sessionError}
                onRetry={() => {
                  setSessionError("");
                  setFeedImages([]);
                  setPage(4);
                }}
                sessionReady={Boolean(sessionId)}
                sessionId={sessionId || ""}
                token={authToken}
                onShareStateChange={(count) => {
                  handleShareStateChange(count);
                  refreshNotifications();
                }}
              />
            ) : null}
            {!wallOnlyMode && page === 5 ? (
              <SpotCheckPage
                spotCheckImage={spotCheckImage}
                loading={!spotCheckImage && !spotCheckError}
                error={spotCheckError}
                onRetry={() => { setSpotCheckError(""); setSpotCheckImage(null); }}
                onComplete={(timing) => { setSpotCheckResult(timing); goTo(6); }}
              />
            ) : null}
            {!wallOnlyMode && page === 6 ? <AwarenessPage awarenessText={awarenessText} setAwarenessText={setAwarenessText} onContinue={() => goTo(7)} /> : null}
            {!wallOnlyMode && page === 7 ? <PolicyPage policy={policy} setPolicy={setPolicy} onSubmit={submitSurvey} submitting={submitting} /> : null}
            {!wallOnlyMode && page === 8 ? <ThankYouPage onContinueWall={() => goTo(9)} onDone={clearAuth} /> : null}
            {page === 9 ? <CommunityWallPage token={authToken} wallPosts={wallPosts} loading={wallLoading} error={wallError} onRetry={() => setPage(9)} onLike={handleLikeWallPost} onRefresh={refreshWall} onReply={(tid) => { setReplyTargetId(tid); setPage(10); }} /> : null}
            {page === 10 ? <MessagesPage token={authToken} onOpenWall={() => setPage(9)} currentUserId={authUser?.user_id} initialTargetId={replyTargetId} onClearTarget={() => setReplyTargetId(null)} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}