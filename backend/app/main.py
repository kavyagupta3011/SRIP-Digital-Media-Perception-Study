from __future__ import annotations

import json
import os
import random
import string
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from typing import Any

import pandas as pd
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import re as _re
from filelock import FileLock
try:
  from .email_service import is_dev_mode, send_otp_email, send_share_email
except ImportError:
  from email_service import is_dev_mode, send_otp_email, send_share_email


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATASET_DIR = DATA_DIR / "dataset"
MANIFEST_PATH = DATA_DIR / "dataset_manifest.csv"

# Dynamic data (user data, responses) goes to STORE_DIR which is the persistent
# volume in production (/app/store) and falls back to DATA_DIR locally.
_store_env = os.getenv("STORE_DIR", "").strip()
STORE_DIR = Path(_store_env) if _store_env else DATA_DIR
STORE_DIR.mkdir(parents=True, exist_ok=True)

PARTICIPANTS_CSV = STORE_DIR / "participants.csv"
RESPONSES_CSV = STORE_DIR / "responses.csv"
USERS_JSON = STORE_DIR / "users.json"
NOTIFICATIONS_JSON = STORE_DIR / "notifications.json"
SHARED_POSTS_JSON = STORE_DIR / "shared_posts.json"
PENDING_SHARE_EMAILS_JSON = STORE_DIR / "pending_share_emails.json"
MESSAGES_JSON = STORE_DIR / "messages.json"
DROPOUTS_CSV = STORE_DIR / "dropouts.csv"
SPOT_CHECKS_CSV = STORE_DIR / "spot_checks.csv"
ENV_PATH = BASE_DIR / ".env"
JWT_ALGORITHM = "HS256"
OTP_MINUTES = 10

DATASET_DIR.mkdir(parents=True, exist_ok=True)



# -- Signal Detection Theory helpers -----------------------------------------
def _erfinv(x: float) -> float:
  """Rational approximation of inverse error function (Abramowitz & Stegun)."""
  import math
  a = 0.147
  sign = 1.0 if x >= 0 else -1.0
  x = abs(x)
  if x >= 1.0:
    return sign * float("inf")
  ln = math.log(1.0 - x * x)
  t1 = 2.0 / (math.pi * a) + ln / 2.0
  return sign * math.sqrt(math.sqrt(t1 * t1 - ln / a) - t1)

def _z(p: float) -> float:
  """Probit: inverse normal CDF. Clamps to (0.001, 0.999) to avoid +/-inf."""
  import math
  p = max(0.001, min(0.999, p))
  return math.sqrt(2.0) * _erfinv(2.0 * p - 1.0)

def compute_dprime(hit_rate: float | None, fa_rate: float | None) -> tuple[float | None, float | None]:
  """
  d'  = z(H) - z(FA)   -- sensitivity (higher = better discrimination)
  c   = -0.5*(z(H)+z(FA)) -- response criterion (>0 = conservative/biased-real, <0 = liberal/biased-AI)
  hit_rate = P(respond AI | is AI) = ai_detection_rate
  fa_rate  = P(respond AI | is real) = 1 - real_detection_rate
  """
  if hit_rate is None or fa_rate is None:
    return None, None
  zh = _z(hit_rate)
  zf = _z(fa_rate)
  return round(zh - zf, 4), round(-0.5 * (zh + zf), 4)


# -- Publication-grade stats helpers (hand-rolled, no scipy/numpy dependency) -
def wilson_ci(successes: float, n: int, z: float = 1.96) -> tuple[float, float] | tuple[None, None]:
  """
  Wilson score interval for a binomial proportion. More accurate than the
  naive normal approximation at the small-n / extreme-proportion samples
  individual spot-check buckets tend to have (each participant contributes
  at most one observation per label-size bucket).
  """
  import math
  if not n:
    return None, None
  phat = successes / n
  denom = 1.0 + (z * z) / n
  center = (phat + (z * z) / (2 * n)) / denom
  half = (z / denom) * math.sqrt((phat * (1.0 - phat) / n) + (z * z) / (4.0 * n * n))
  return round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)


def _norm_cdf(x: float) -> float:
  """Standard normal CDF via the exact error function (math.erf is in stdlib)."""
  import math
  return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _gammp_series(a: float, x: float) -> float:
  """Regularized lower incomplete gamma P(a,x), series form (valid x < a+1)."""
  import math
  if x <= 0:
    return 0.0
  ap = a
  total = 1.0 / a
  delta = total
  for _ in range(300):
    ap += 1.0
    delta *= x / ap
    total += delta
    if abs(delta) < abs(total) * 1e-12:
      break
  return total * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _gammq_cf(a: float, x: float) -> float:
  """Regularized upper incomplete gamma Q(a,x), continued-fraction form (valid x >= a+1)."""
  import math
  tiny = 1e-300
  b = x + 1.0 - a
  c = 1.0 / tiny
  d = 1.0 / b
  h = d
  for i in range(1, 300):
    an = -i * (i - a)
    b += 2.0
    d = an * d + b
    if abs(d) < tiny:
      d = tiny
    c = b + an / c
    if abs(c) < tiny:
      c = tiny
    d = 1.0 / d
    delta = d * c
    h *= delta
    if abs(delta - 1.0) < 1e-12:
      break
  return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def chi2_sf(stat: float, dof: int) -> float | None:
  """
  Upper-tail p-value for a chi-square statistic. Implemented by hand
  (Numerical-Recipes-style regularized incomplete gamma) so the project
  doesn't need a scipy dependency just for one significance test.
  """
  if stat is None or dof is None or dof <= 0:
    return None
  if stat <= 0:
    return 1.0
  a = dof / 2.0
  x = stat / 2.0
  try:
    if x < a + 1.0:
      return round(max(0.0, min(1.0, 1.0 - _gammp_series(a, x))), 6)
    return round(max(0.0, min(1.0, _gammq_cf(a, x))), 6)
  except (ValueError, OverflowError):
    return None


def fit_logistic_1d(xs: list[float], ys: list[bool | float]) -> dict[str, Any] | None:
  """
  Fits P(y=1) = logistic(b0 + b1*x) by hand via Newton-Raphson / IRLS (no
  scipy/numpy). Used to estimate the spot-check "detection threshold"
  psychometric curve -- hit rate as a function of label_size_pct. Returns
  None if there's not enough data or variation to fit a stable curve.
  """
  import math
  n = len(xs)
  if n < 8:
    return None
  y = [1.0 if v else 0.0 for v in ys]
  if len(set(xs)) < 2 or len(set(y)) < 2:
    return None

  b0, b1 = 0.0, 0.0
  for _ in range(50):
    s00 = s01 = s11 = g0 = g1 = 0.0
    for xi, yi in zip(xs, y):
      eta = max(-30.0, min(30.0, b0 + b1 * xi))
      p = 1.0 / (1.0 + math.exp(-eta))
      w = p * (1.0 - p)
      s00 += w
      s01 += w * xi
      s11 += w * xi * xi
      g0 += (yi - p)
      g1 += (yi - p) * xi
    det = s00 * s11 - s01 * s01
    if abs(det) < 1e-12:
      return None
    db0 = (s11 * g0 - s01 * g1) / det
    db1 = (s00 * g1 - s01 * g0) / det
    b0 += db0
    b1 += db1
    if abs(db0) < 1e-8 and abs(db1) < 1e-8:
      break

  # Recompute the information matrix at convergence for standard errors.
  s00 = s01 = s11 = 0.0
  for xi in xs:
    eta = max(-30.0, min(30.0, b0 + b1 * xi))
    p = 1.0 / (1.0 + math.exp(-eta))
    w = p * (1.0 - p)
    s00 += w
    s01 += w * xi
    s11 += w * xi * xi
  det = s00 * s11 - s01 * s01
  if abs(det) < 1e-12:
    return None
  var_b1 = s00 / det
  var_b0 = s11 / det
  se_b1 = math.sqrt(var_b1) if var_b1 > 0 else None
  se_b0 = math.sqrt(var_b0) if var_b0 > 0 else None

  z_b1 = (b1 / se_b1) if se_b1 else None
  p_b1 = round(2.0 * (1.0 - _norm_cdf(abs(z_b1))), 6) if z_b1 is not None else None

  def threshold_for(q: float) -> float | None:
    if b1 == 0:
      return None
    logit_q = math.log(q / (1.0 - q))
    return (logit_q - b0) / b1

  return {
    "intercept": round(b0, 6),
    "slope": round(b1, 6),
    "slope_se": round(se_b1, 6) if se_b1 else None,
    "slope_p_value": p_b1,
    "threshold_50": threshold_for(0.5),
    "threshold_75": threshold_for(0.75),
    "n": n,
  }


def bootstrap_threshold_ci(xs: list[float], ys: list[bool | float], n_boot: int = 300, level: str = "threshold_50",
                            seed: str = "psychometric_bootstrap") -> tuple[float, float] | tuple[None, None]:
  """Percentile bootstrap (resampling rows with replacement) for a 95% CI on
  the fitted detection threshold. Cheap because each refit is a ~50-iteration
  2-parameter Newton solve over at most a few hundred rows."""
  n = len(xs)
  if n < 15:
    return None, None
  rng = random.Random(seed)
  estimates: list[float] = []
  for _ in range(n_boot):
    idx = [rng.randrange(n) for _ in range(n)]
    fit = fit_logistic_1d([xs[i] for i in idx], [ys[i] for i in idx])
    if fit is None:
      continue
    thr = fit.get(level)
    if thr is not None and -5.0 <= thr <= 5.0:  # guard against wild extrapolation
      estimates.append(thr)
  if len(estimates) < 30:
    return None, None
  estimates.sort()
  lo_idx = int(0.025 * len(estimates))
  hi_idx = min(len(estimates) - 1, int(0.975 * len(estimates)))
  return round(estimates[lo_idx], 4), round(estimates[hi_idx], 4)


def pearson_with_p(xs: list[float], ys: list[float]) -> dict[str, Any] | None:
  """
  Pearson correlation with a significance test via the Fisher z-transform
  (normal approximation -- standard practice for correlation significance
  and avoids needing scipy's incomplete-beta t-distribution CDF). Used for
  demographic-vs-accuracy and cross-task correlations.
  """
  import math
  pairs = [
    (x, y) for x, y in zip(xs, ys)
    if x is not None and y is not None
    and not (isinstance(x, float) and math.isnan(x))
    and not (isinstance(y, float) and math.isnan(y))
  ]
  n = len(pairs)
  if n < 4:
    return None
  mx = sum(p[0] for p in pairs) / n
  my = sum(p[1] for p in pairs) / n
  sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
  sxx = sum((p[0] - mx) ** 2 for p in pairs)
  syy = sum((p[1] - my) ** 2 for p in pairs)
  if sxx <= 0 or syy <= 0:
    return {"r": None, "n": n, "p_value": None}
  r = sxy / math.sqrt(sxx * syy)
  r_clamped = max(-0.999999, min(0.999999, r))
  p_value = None
  if n > 3:
    fz = math.atanh(r_clamped) * math.sqrt(n - 3)
    p_value = round(2.0 * (1.0 - _norm_cdf(abs(fz))), 6)
  return {"r": round(r, 4), "n": n, "p_value": p_value}


CATEGORIES = [f"cat{index:02d}" for index in range(1, 11)]
LABEL_SIZES = [0.0, 0.1, 0.25, 0.5, 1.0, 1.5]

PARTICIPANT_COLUMNS = [
  "session_id", "user_id", "submitted_at", "survey_start_time", "total_duration_minutes", "hour_of_day",
  "name", "email", "age", "gender", "ai_frequency", "ai_confidence",
  "attention_check_passed",
  "total_images", "total_correct", "overall_accuracy",
  "ai_images", "ai_correct", "ai_detection_rate",
  "real_images", "real_correct", "real_detection_rate",
  "nolabel_accuracy", "label_0_1_accuracy", "label_0_25_accuracy", "label_0_5_accuracy", "label_1_0_accuracy", "label_1_5_accuracy",
  "avg_dwell_nolabel", "avg_dwell_0_1", "avg_dwell_0_25", "avg_dwell_0_5", "avg_dwell_1_0", "avg_dwell_1_5",
  "avg_rt_nolabel", "avg_rt_0_1", "avg_rt_0_25", "avg_rt_0_5", "avg_rt_1_0", "avg_rt_1_5",
  "avg_label_hover_ms", "avg_zoom_count",
  "dprime", "response_bias",
  # SDT per label condition (hit rate per condition, FA rate fixed from real images)
  "dprime_nolabel", "dprime_0_1", "dprime_0_25", "dprime_0_5", "dprime_1_0", "dprime_1_5",
  "bias_nolabel", "bias_0_1", "bias_0_25", "bias_0_5", "bias_1_0", "bias_1_5",
  # Label nudge effect: P(say AI Modified) per condition vs no-label baseline
  "compliance_nolabel", "compliance_0_1", "compliance_0_25", "compliance_0_5", "compliance_1_0", "compliance_1_5",
  "nudge_0_1", "nudge_0_25", "nudge_0_5", "nudge_1_0", "nudge_1_5",
  # Efficiency and consistency
  "ies_overall",
  "rt_sd",
  # Learning/fatigue effect within session
  "first_half_accuracy", "second_half_accuracy", "learning_effect",
  # Revisit rate per label condition
  "avg_revisits_nolabel", "avg_revisits_0_1", "avg_revisits_0_25", "avg_revisits_0_5", "avg_revisits_1_0", "avg_revisits_1_5",
  "avg_revisits_post_verdict", "verdict_change_rate",
  "total_liked", "total_shared",
  "awareness_response",
  "max_scroll_depth_pct", "device_type", "browser", "screen_width", "viewport_width",
]

RESPONSES_COLUMNS = [
  "session_id", "user_id", "submitted_at", "image_position_in_feed",
  "image_id", "category_id", "image_type", "is_ai",
  "label_size_pct", "label_position", "label_type", "category_folder",
  "participant_verdict", "is_correct", "reason_text",
  "dwell_ms", "response_time_ms", "scroll_revisits", "revisit_scroll_up", "revisit_scroll_down",
  "label_hover_ms", "label_noticed", "label_compliance",
  "revisits_post_verdict", "revisit_scroll_up_post", "revisit_scroll_down_post",
  "verdict_changed", "verdict_change_count",
  "zoom_count", "image_load_time_ms",
  "liked", "shared", "share_count",
  "device_type", "browser", "screen_width", "viewport_width",
]

DROPOUT_COLUMNS = [
  "session_id", "user_id", "dropped_at_page", "images_seen_count", "timestamp",
]

SPOT_CHECK_COLUMNS = [
  "session_id", "user_id", "submitted_at",
  "image_id", "category_id", "category_folder", "image_type", "is_ai",
  "label_size_pct", "label_position", "label_type",
  "ground_truth_has_label", "participant_answer", "is_correct", "fast_guess_flag",
  "dwell_ms", "response_time_ms", "image_load_time_ms", "label_hover_ms",
  "device_type", "browser", "screen_width", "viewport_width",
]

# Below this response-time threshold a "Yes" on a small/subtle label is more
# likely a random guess than genuine detection (used for fast_guess_flag only,
# never used to discard or alter a participant's actual answer).
FAST_GUESS_MS_THRESHOLD = 1500
FAST_GUESS_LABEL_SIZES = {0.1, 0.25}

# -- Load .env before app creation so CORS and secrets are correct ------------
def load_env_file(path: Path) -> None:
  if not path.exists():
    return
  for raw_line in path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
      continue
    key, value = line.split("=", 1)
    os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(ENV_PATH)

JWT_SECRET = os.getenv("JWT_SECRET", "srip_jwt_secret_iiitb_study_2025_xk9")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "srip_admin_2025")
EXPORT_SECRET = os.getenv("EXPORT_SECRET", "srip2025")
STUDY_LINK = os.getenv("STUDY_LINK", "http://localhost:5173")

_cors_origins = ["http://localhost:5173", "http://localhost:3000"]
if STUDY_LINK and STUDY_LINK not in _cors_origins:
  _cors_origins.append(STUDY_LINK)

app = FastAPI(title="SRIP Survey API")

app.add_middleware(
  CORSMiddleware,
  allow_origins=_cors_origins,
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)

DATASET_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/images", StaticFiles(directory=str(DATASET_DIR)), name="images")


class ParticipantPayload(BaseModel):
  name: str
  email: str
  roll_no: str
  age: int
  gender: str
  ai_frequency: int
  ai_confidence: int


class ResponsePayload(BaseModel):
  image_id: str
  category_id: str = ""
  image_type: str = ""
  is_ai: bool = False
  label_size_pct: float = 0.0
  label_position: str = ""
  label_type: str = ""
  category_folder: str = ""
  participant_verdict: str | None = None
  is_correct: bool = False
  reason_text: str = ""
  dwell_ms: float = 0.0
  response_time_ms: float | None = None
  liked: bool = False
  shared: bool = False
  shared_with_count: int = 0
  share_recipients: str = ""
  community_wall_likes: int = 0
  scroll_revisits: int = 0
  revisit_scroll_up: int = 0
  revisit_scroll_down: int = 0
  label_hover_ms: float = 0.0
  label_noticed: bool = False
  revisits_post_verdict: int = 0
  revisit_scroll_up_post: int = 0
  revisit_scroll_down_post: int = 0
  verdict_changed: bool = False
  verdict_change_count: int = 0
  zoom_count: int = 0
  image_load_time_ms: float | None = None
  image_position_in_feed: int = 0


class SpotCheckPayload(BaseModel):
  image_id: str = ""
  category_id: str = ""
  category_folder: str = ""
  image_type: str = ""
  is_ai: bool = False
  label_size_pct: float = 0.0
  label_position: str = ""
  label_type: str = ""
  participant_answer: bool | None = None
  dwell_ms: float = 0.0
  response_time_ms: float | None = None
  image_load_time_ms: float | None = None
  label_hover_ms: float = 0.0


class PolicyPayload(BaseModel):
  responsibility: str = ""
  legal_requirement: int | None = None


class DevicePayload(BaseModel):
  device_type: str = ""
  browser: str = ""
  screen_width: int = 0
  screen_height: int = 0
  viewport_width: int = 0
  device_info: str = ""


class SubmitPayload(BaseModel):
  session_id: str
  participant: ParticipantPayload
  responses: list[ResponsePayload]
  awareness_response: str = ""
  spot_check: SpotCheckPayload = Field(default_factory=SpotCheckPayload)
  policy: PolicyPayload = Field(default_factory=PolicyPayload)
  total_time_ms: int = 0
  submitted_at: str
  survey_start_time: str = ""
  attention_check_passed: bool | None = None
  max_scroll_depth_pct: float = 0.0
  device: DevicePayload = Field(default_factory=DevicePayload)


class AuthStartPayload(BaseModel):
  email: str
  name: str = ""
  roll_no: str = ""


class AuthVerifyPayload(BaseModel):
  email: str
  otp: str


class SocialSharePayload(BaseModel):
  image_id: str
  image_url: str
  feed_caption: str
  feed_source_tag: str
  category_id: str = ""
  share_with_user_ids: list[str] = Field(default_factory=list)
  participant_verdict: str | None = None
  sharer_verdict: str | None = None


class LikePayload(BaseModel):
  post_id: str


class NotificationsReadPayload(BaseModel):
  notification_ids: list[str] = Field(default_factory=list)


class HeartbeatPayload(BaseModel):
  device_info: str = ""


class DropoutPayload(BaseModel):
  session_id: str = ""
  dropped_at_page: int = 0
  images_seen: int = 0


class MessageSendPayload(BaseModel):
  text: str


class AdminLoginPayload(BaseModel):
  password: str


def now_utc() -> datetime:
  return datetime.now(timezone.utc)


def iso_now() -> str:
  return now_utc().isoformat()


def parse_iso_datetime(value: str) -> datetime:
  normalized = value.replace("Z", "+00:00")
  parsed = datetime.fromisoformat(normalized)
  if parsed.tzinfo is None:
    return parsed.replace(tzinfo=timezone.utc)
  return parsed.astimezone(timezone.utc)


def _lock_for(path: Path) -> FileLock:
  """Return a per-file FileLock stored next to the file."""
  return FileLock(str(path) + ".lock", timeout=10)


def load_json(path: Path, default: Any) -> Any:
  with _lock_for(path):
    if not path.exists():
      return default
    try:
      return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
      return default


def save_json(path: Path, data: Any) -> None:
  # Atomic write under a file lock so concurrent processes can't race
  with _lock_for(path):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def update_json(path: Path, default: Any, mutate: Any) -> Any:
  """Read-modify-write a JSON store under a SINGLE lock acquisition.

  load_json() and save_json() each grab and release the lock on their own,
  so a "load -> modify in Python -> save" sequence has a gap in between
  where another worker process (we run 4, see Procfile) can do its own
  load/modify/save and have its change silently overwritten once we save
  our (now stale) copy -- a classic lost-update race. This closes that gap
  by holding the lock for the entire read-modify-write, so two simultaneous
  requests touching the same store (e.g. two people sending messages, two
  shares landing on the same recipient's notifications) can't clobber each
  other. `mutate(data)` is called with the loaded data and should mutate it
  in place; its return value (if any) is passed back to the caller, and any
  exception raised inside `mutate` aborts before anything is written.
  """
  with _lock_for(path):
    if path.exists():
      try:
        data = json.loads(path.read_text(encoding="utf-8"))
      except json.JSONDecodeError:
        data = default
    else:
      data = default
    result = mutate(data)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)
    return result


def generate_otp() -> str:
  return "".join(random.choices(string.digits, k=6))


def create_token(user_id: str, email: str, name: str) -> str:
  payload = {
    "sub": user_id,
    "email": email,
    "name": name,
    "exp": now_utc() + timedelta(days=7),
    "iat": now_utc(),
  }
  return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict[str, Any] | None:
  try:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
  except jwt.PyJWTError:
    return None


async def get_current_user(authorization: str = Header(None)) -> dict[str, Any]:
  if not authorization or not authorization.startswith("Bearer "):
    raise HTTPException(status_code=401, detail="Not authenticated")

  token = authorization.split(" ", 1)[1].strip()
  payload = verify_token(token)
  if not payload:
    raise HTTPException(status_code=401, detail="Invalid or expired token")

  user_id = str(payload.get("sub") or "")
  email = str(payload.get("email") or "").lower()
  users = load_json(USERS_JSON, {})
  user_record = users.get(email)
  if not user_record and user_id:
    for record in users.values():
      if str(record.get("user_id") or "") == user_id:
        user_record = record
        break

  if not user_record:
    raise HTTPException(status_code=401, detail="User not found")

  return user_record


def normalize_email(value: str) -> str:
  return value.strip().lower()


def thread_key(user_a: str, user_b: str) -> str:
  ordered = sorted([user_a, user_b])
  return f"{ordered[0]}_{ordered[1]}"


def user_is_online(user: dict[str, Any]) -> bool:
  last_active = str(user.get("last_active") or "")
  if not last_active:
    return False
  try:
    return parse_iso_datetime(last_active) >= now_utc() - timedelta(seconds=120)
  except ValueError:
    return False


def presence_label(user: dict[str, Any]) -> str:
  if user_is_online(user):
    return "Online"
  last_active = str(user.get("last_active") or "")
  if not last_active:
    return "Offline"
  try:
    delta = now_utc() - parse_iso_datetime(last_active)
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
      return f"{max(1, minutes)} min ago"
  except ValueError:
    pass
  return "Offline"


def load_messages_store() -> dict[str, list[dict[str, Any]]]:
  messages = load_json(MESSAGES_JSON, {})
  return messages if isinstance(messages, dict) else {}


def save_messages_store(messages: dict[str, list[dict[str, Any]]]) -> None:
  save_json(MESSAGES_JSON, messages)


def append_message(thread_id: str, message: dict[str, Any]) -> None:
  def _mutate(messages: dict[str, Any]) -> None:
    bucket = messages.get(thread_id) or []
    bucket.append(message)
    messages[thread_id] = bucket

  update_json(MESSAGES_JSON, {}, _mutate)


def require_admin(password: str = Header(None, alias="X-Admin-Password")) -> None:
  if password != ADMIN_PASSWORD:
    raise HTTPException(status_code=403, detail="Invalid admin password")


def load_user_store() -> dict[str, dict[str, Any]]:
  users = load_json(USERS_JSON, {})
  return users if isinstance(users, dict) else {}


def save_user_store(users: dict[str, dict[str, Any]]) -> None:
  save_json(USERS_JSON, users)


def load_notifications_store() -> dict[str, list[dict[str, Any]]]:
  notifications = load_json(NOTIFICATIONS_JSON, {})
  return notifications if isinstance(notifications, dict) else {}


def save_notifications_store(notifications: dict[str, list[dict[str, Any]]]) -> None:
  save_json(NOTIFICATIONS_JSON, notifications)


def load_shared_posts() -> list[dict[str, Any]]:
  shared_posts = load_json(SHARED_POSTS_JSON, [])
  return shared_posts if isinstance(shared_posts, list) else []


def save_shared_posts(shared_posts: list[dict[str, Any]]) -> None:
  save_json(SHARED_POSTS_JSON, shared_posts)


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
  for user in load_user_store().values():
    if str(user.get("user_id") or "") == user_id:
      return user
  return None


def upsert_user(email: str, name: str, roll_no: str) -> dict[str, Any]:
  normalized_email = normalize_email(email)

  def _mutate(users: dict[str, Any]) -> dict[str, Any]:
    user = users.get(normalized_email)
    if not user:
      user = {
        "user_id": str(uuid.uuid4()),
        "email": normalized_email,
        "name": name.strip(),
        "roll_no": roll_no.strip(),
        "registered_at": iso_now(),
        "last_active": iso_now(),
        "study_completed": False,
        "otp": "",
        "otp_expires_at": "",
        "session_count": 0,
        "device_info": "",
      }
    else:
      if name.strip():
        user["name"] = name.strip()
      if roll_no.strip():
        user["roll_no"] = roll_no.strip()
    user["last_active"] = iso_now()
    users[normalized_email] = user
    return user

  return update_json(USERS_JSON, {}, _mutate)


def queue_otp(user: dict[str, Any]) -> tuple[str, bool]:
  otp = generate_otp()
  expires_at = (now_utc() + timedelta(minutes=OTP_MINUTES)).isoformat()
  email = user["email"]

  def _mutate(users: dict[str, Any]) -> None:
    record = users.get(email, user)
    record["otp"] = otp
    record["otp_expires_at"] = expires_at
    users[email] = record

  update_json(USERS_JSON, {}, _mutate)
  user["otp"] = otp
  user["otp_expires_at"] = expires_at
  emailed = send_otp_email(user["email"], otp, str(user.get("name") or ""))
  return otp, emailed


def get_notification_bucket(notifications: dict[str, list[dict[str, Any]]], email: str) -> list[dict[str, Any]]:
  bucket = notifications.get(email)
  if bucket is None:
    bucket = []
    notifications[email] = bucket
  return bucket


def _validate_csv_columns(csv_path: Path, expected_columns: list[str]) -> bool:
  """Return True if the CSV exists and has exactly the expected columns."""
  if not csv_path.exists():
    return False
  try:
    header = pd.read_csv(csv_path, nrows=0).columns.tolist()
    return header == expected_columns
  except Exception:
    return False


def ensure_runtime_files() -> None:
  STORE_DIR.mkdir(parents=True, exist_ok=True)
  if not _validate_csv_columns(PARTICIPANTS_CSV, PARTICIPANT_COLUMNS):
    backup = PARTICIPANTS_CSV.with_suffix(".csv.bak")
    if PARTICIPANTS_CSV.exists():
      import shutil as _shutil
      _shutil.copy2(PARTICIPANTS_CSV, backup)
    pd.DataFrame(columns=PARTICIPANT_COLUMNS).to_csv(PARTICIPANTS_CSV, index=False)
  if not _validate_csv_columns(RESPONSES_CSV, RESPONSES_COLUMNS):
    backup = RESPONSES_CSV.with_suffix(".csv.bak")
    if RESPONSES_CSV.exists():
      import shutil as _shutil
      _shutil.copy2(RESPONSES_CSV, backup)
    pd.DataFrame(columns=RESPONSES_COLUMNS).to_csv(RESPONSES_CSV, index=False)
  if not _validate_csv_columns(DROPOUTS_CSV, DROPOUT_COLUMNS):
    pd.DataFrame(columns=DROPOUT_COLUMNS).to_csv(DROPOUTS_CSV, index=False)
  if not _validate_csv_columns(SPOT_CHECKS_CSV, SPOT_CHECK_COLUMNS):
    pd.DataFrame(columns=SPOT_CHECK_COLUMNS).to_csv(SPOT_CHECKS_CSV, index=False)
  if not USERS_JSON.exists():
    save_json(USERS_JSON, {})
  if not NOTIFICATIONS_JSON.exists():
    save_json(NOTIFICATIONS_JSON, {})
  if not SHARED_POSTS_JSON.exists():
    save_json(SHARED_POSTS_JSON, [])
  if not MESSAGES_JSON.exists():
    save_json(MESSAGES_JSON, {})
  if not PENDING_SHARE_EMAILS_JSON.exists():
    save_json(PENDING_SHARE_EMAILS_JSON, {})


def load_manifest() -> pd.DataFrame:
  if not MANIFEST_PATH.exists():
    raise HTTPException(status_code=500, detail="dataset_manifest.csv is missing")

  manifest = pd.read_csv(MANIFEST_PATH)
  required_columns = {
    "image_id",
    "filename",
    "category_id",
    "category_folder",
    "image_type",
    "is_ai",
    "label_size_pct",
    "label_position",
    "feed_caption",
    "feed_source_tag",
  }
  missing = sorted(required_columns - set(manifest.columns))
  if missing:
    raise HTTPException(status_code=500, detail=f"Manifest is missing columns: {', '.join(missing)}")

  manifest["label_size_pct"] = pd.to_numeric(manifest["label_size_pct"], errors="coerce").fillna(0.0)
  manifest["label_position"] = manifest["label_position"].fillna("").replace({"none": ""})
  manifest["image_type"] = manifest["image_type"].fillna("")
  manifest["feed_caption"] = manifest["feed_caption"].fillna("")
  manifest["feed_source_tag"] = manifest["feed_source_tag"].fillna("")

  def normalize_is_ai(value: Any) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes", "ai", "ai_labeled", "ai_nolabel"}

  def normalize_type(row: pd.Series) -> str:
    raw_type = str(row["image_type"]).strip().lower()
    if raw_type in {"ai", "ai_nolabel"}:
      return "ai_nolabel"
    if raw_type == "ai_labeled":
      return "ai_labeled"
    return "real"

  def build_url(row: pd.Series) -> str:
    folder = str(row["category_folder"]).strip()
    image_type = normalize_type(row)
    filename = str(row["filename"]).strip()
    label_size = float(row["label_size_pct"])
    if image_type == "real":
      return f"/images/{folder}/real/{filename}"
    elif image_type == "ai_nolabel":
      return f"/images/{folder}/ai_nolabel/{filename}"
    else:
      match = _re.search(r"_ai_([0-9]+\.?[0-9]*)pct_", filename)
      if match:
        size_str = match.group(1)
      else:
        size_str = f"{float(row['label_size_pct']):g}"
      return f"/images/{folder}/ai_label_{size_str}pct/{filename}"


  manifest["is_ai"] = manifest["is_ai"].map(normalize_is_ai)
  manifest["image_type"] = manifest.apply(normalize_type, axis=1)
  manifest["image_url"] = manifest.apply(build_url, axis=1)
  return manifest


def as_image_object(row: pd.Series) -> dict[str, Any]:
  return {
    "image_id": str(row["image_id"]),
    "filename": str(row["filename"]),
    "category_id": str(row["category_id"]),
    "category_folder": str(row.get("category_folder", "")),
    "image_type": str(row["image_type"]),
    "is_ai": bool(row["is_ai"]),
    "label_size_pct": float(row["label_size_pct"]),
    "label_position": str(row["label_position"]),
    "label_type": str(row.get("label_type", "")),
    "feed_caption": str(row["feed_caption"]),
    "feed_source_tag": str(row["feed_source_tag"]),
    "image_url": str(row["image_url"]),
  }


def mean_or_none(values: list[float]) -> float | None:
  return float(mean(values)) if values else None


def numeric_or_none(value: Any) -> float | None:
  if value is None:
    return None
  return float(value)


def compact_numbers(values: list[float | None]) -> list[float]:
  return [value for value in values if value is not None]


def append_row(csv_path: Path, row: dict[str, Any], columns: list[str]) -> None:
  frame = pd.DataFrame([row], columns=columns)
  with _lock_for(csv_path):
    frame.to_csv(csv_path, mode="a", index=False, header=False)


def compute_metrics(submit_payload: SubmitPayload) -> dict[str, Any]:
  responses = submit_payload.responses
  total_images = len(responses)
  total_correct = sum(1 for response in responses if response.is_correct)
  ai_responses = [response for response in responses if response.is_ai]
  real_responses = [response for response in responses if not response.is_ai]
  ai_images_correct = sum(1 for response in ai_responses if response.is_correct)
  real_images_correct = sum(1 for response in real_responses if response.is_correct)

  label_metrics: list[dict[str, Any]] = []
  for size in LABEL_SIZES:
    grouped = [response for response in responses if response.is_ai and float(response.label_size_pct) == size]
    label_metrics.append(
      {
        "label_size_pct": size,
        "accuracy": mean_or_none([1.0 if response.is_correct else 0.0 for response in grouped]),
        "avg_dwell_ms": mean_or_none([float(response.dwell_ms) for response in grouped]),
        "avg_rt_ms": mean_or_none(compact_numbers([numeric_or_none(response.response_time_ms) for response in grouped])),
      }
    )

  def accuracy_for(size: float, nolabel_only: bool = False) -> float | None:
    grouped = [
      response for response in responses
      if response.is_ai and float(response.label_size_pct) == size and (not nolabel_only or response.image_type == "ai_nolabel")
    ]
    return mean_or_none([1.0 if response.is_correct else 0.0 for response in grouped])

  # Fixed FA rate (from real images -- same for all conditions in a within-subjects design)
  fa_rate = 1.0 - (real_images_correct / len(real_responses)) if real_responses else None

  def _hit_rate(size: float, nolabel_only: bool = False) -> float | None:
    grouped = [
      r for r in responses
      if r.is_ai and float(r.label_size_pct) == size and (not nolabel_only or r.image_type == "ai_nolabel")
    ]
    if not grouped:
      return None
    return sum(1 for r in grouped if r.participant_verdict == "ai_modified") / len(grouped)

  # Label compliance: P(say "AI Modified") for each condition, regardless of correctness
  # This is the key nudge metric -- captures behavior change independent of accuracy
  def _compliance(size: float, nolabel_only: bool = False) -> float | None:
    grouped = [
      r for r in responses
      if r.is_ai and float(r.label_size_pct) == size and (not nolabel_only or r.image_type == "ai_nolabel")
    ]
    if not grouped:
      return None
    return sum(1 for r in grouped if r.participant_verdict == "ai_modified") / len(grouped)

  comp_nolabel = _compliance(0.0, nolabel_only=True)
  comp_0_1   = _compliance(0.1)
  comp_0_25  = _compliance(0.25)
  comp_0_5   = _compliance(0.5)
  comp_1_0   = _compliance(1.0)
  comp_1_5   = _compliance(1.5)

  def _nudge(comp: float | None) -> float | None:
    if comp is None or comp_nolabel is None:
      return None
    return round(comp - comp_nolabel, 4)

  # IES = mean_RT / accuracy_proportion (lower = better; penalises slow+inaccurate equally)
  all_rts = compact_numbers([numeric_or_none(r.response_time_ms) for r in responses])
  mean_rt_all = sum(all_rts) / len(all_rts) if all_rts else None
  overall_acc = total_correct / total_images if total_images else None
  ies_overall = round(mean_rt_all / overall_acc, 2) if (mean_rt_all and overall_acc) else None

  # RT standard deviation (decision consistency)
  rt_sd: float | None = None
  if len(all_rts) >= 2:
    mean_rt = sum(all_rts) / len(all_rts)
    variance = sum((x - mean_rt) ** 2 for x in all_rts) / (len(all_rts) - 1)
    rt_sd = round(variance ** 0.5, 2)

  # Learning effect: compare first half vs second half of feed (by image_position_in_feed)
  sorted_responses = sorted(responses, key=lambda r: r.image_position_in_feed)
  mid = len(sorted_responses) // 2
  first_half = sorted_responses[:mid]
  second_half = sorted_responses[mid:]
  first_half_acc = sum(1 for r in first_half if r.is_correct) / len(first_half) if first_half else None
  second_half_acc = sum(1 for r in second_half if r.is_correct) / len(second_half) if second_half else None
  learning_effect = round(second_half_acc - first_half_acc, 4) if (first_half_acc is not None and second_half_acc is not None) else None

  # Revisit rate per label condition
  def _avg_revisits(size: float, nolabel_only: bool = False) -> float | None:
    grouped = [
      r for r in responses
      if r.is_ai and float(r.label_size_pct) == size and (not nolabel_only or r.image_type == "ai_nolabel")
    ]
    return mean_or_none([float(r.scroll_revisits) for r in grouped])

  return {
    "total_images": total_images,
    "total_correct": total_correct,
    "overall_accuracy": overall_acc,
    "ai_images": len(ai_responses),
    "ai_correct": ai_images_correct,
    "ai_detection_rate": ai_images_correct / len(ai_responses) if ai_responses else None,
    "real_images": len(real_responses),
    "real_correct": real_images_correct,
    "real_detection_rate": real_images_correct / len(real_responses) if real_responses else None,
    "nolabel_accuracy": accuracy_for(0.0, nolabel_only=True),
    "label_0_1_accuracy": accuracy_for(0.1),
    "label_0_25_accuracy": accuracy_for(0.25),
    "label_0_5_accuracy": accuracy_for(0.5),
    "label_1_0_accuracy": accuracy_for(1.0),
    "label_1_5_accuracy": accuracy_for(1.5),
    "avg_dwell_nolabel": mean_or_none([float(r.dwell_ms) for r in responses
        if r.is_ai and float(r.label_size_pct) == 0.0 and r.image_type == "ai_nolabel"]),
    "avg_dwell_0_1":  mean_or_none([float(r.dwell_ms) for r in responses
        if r.is_ai and abs(float(r.label_size_pct) - 0.1) < 0.001]),
    "avg_dwell_0_25": mean_or_none([float(r.dwell_ms) for r in responses
        if r.is_ai and abs(float(r.label_size_pct) - 0.25) < 0.001]),
    "avg_dwell_0_5":  mean_or_none([float(r.dwell_ms) for r in responses
        if r.is_ai and abs(float(r.label_size_pct) - 0.5) < 0.001]),
    "avg_dwell_1_0":  mean_or_none([float(r.dwell_ms) for r in responses
        if r.is_ai and abs(float(r.label_size_pct) - 1.0) < 0.001]),
    "avg_dwell_1_5":  mean_or_none([float(r.dwell_ms) for r in responses
        if r.is_ai and abs(float(r.label_size_pct) - 1.5) < 0.001]),
    "avg_rt_nolabel": mean_or_none(compact_numbers([numeric_or_none(r.response_time_ms)
        for r in responses if r.is_ai and float(r.label_size_pct) == 0.0 and r.image_type == "ai_nolabel"])),
    "avg_rt_0_1":  mean_or_none(compact_numbers([numeric_or_none(r.response_time_ms)
        for r in responses if r.is_ai and abs(float(r.label_size_pct) - 0.1) < 0.001])),
    "avg_rt_0_25": mean_or_none(compact_numbers([numeric_or_none(r.response_time_ms)
        for r in responses if r.is_ai and abs(float(r.label_size_pct) - 0.25) < 0.001])),
    "avg_rt_0_5":  mean_or_none(compact_numbers([numeric_or_none(r.response_time_ms)
        for r in responses if r.is_ai and abs(float(r.label_size_pct) - 0.5) < 0.001])),
    "avg_rt_1_0":  mean_or_none(compact_numbers([numeric_or_none(r.response_time_ms)
        for r in responses if r.is_ai and abs(float(r.label_size_pct) - 1.0) < 0.001])),
    "avg_rt_1_5":  mean_or_none(compact_numbers([numeric_or_none(r.response_time_ms)
        for r in responses if r.is_ai and abs(float(r.label_size_pct) - 1.5) < 0.001])),
    "avg_label_hover_ms": mean_or_none([float(response.label_hover_ms) for response in responses if response.image_type == "ai_labeled"]),
    "avg_zoom_count": mean_or_none([float(response.zoom_count) for response in responses]),
    "_dprime_inputs": (
      ai_images_correct / len(ai_responses) if ai_responses else None,
      fa_rate,
    ),
    "_fa_rate": fa_rate,
    # Per-condition SDT (hit rate per condition, FA rate fixed from real images)
    "_cond_hit_rates": {
      "nolabel": _hit_rate(0.0, nolabel_only=True),
      "0_1": _hit_rate(0.1),
      "0_25": _hit_rate(0.25),
      "0_5": _hit_rate(0.5),
      "1_0": _hit_rate(1.0),
      "1_5": _hit_rate(1.5),
    },
    # Label compliance (P(say AI) per condition)
    "compliance_nolabel": comp_nolabel,
    "compliance_0_1":  comp_0_1,
    "compliance_0_25": comp_0_25,
    "compliance_0_5":  comp_0_5,
    "compliance_1_0":  comp_1_0,
    "compliance_1_5":  comp_1_5,
    "nudge_0_1":  _nudge(comp_0_1),
    "nudge_0_25": _nudge(comp_0_25),
    "nudge_0_5":  _nudge(comp_0_5),
    "nudge_1_0":  _nudge(comp_1_0),
    "nudge_1_5":  _nudge(comp_1_5),
    # Efficiency and consistency
    "ies_overall": ies_overall,
    "rt_sd": rt_sd,
    # Learning effect
    "first_half_accuracy":  round(first_half_acc, 4) if first_half_acc is not None else None,
    "second_half_accuracy": round(second_half_acc, 4) if second_half_acc is not None else None,
    "learning_effect": learning_effect,
    # Revisit rates per condition
    "avg_revisits_nolabel": _avg_revisits(0.0, nolabel_only=True),
    "avg_revisits_0_1":  _avg_revisits(0.1),
    "avg_revisits_0_25": _avg_revisits(0.25),
    "avg_revisits_0_5":  _avg_revisits(0.5),
    "avg_revisits_1_0":  _avg_revisits(1.0),
    "avg_revisits_1_5":  _avg_revisits(1.5),
    # Post-verdict revisits and verdict changes
    "avg_revisits_post_verdict": mean_or_none([float(r.revisits_post_verdict) for r in responses]),
    "verdict_change_rate": (sum(1 for r in responses if r.verdict_changed) / len(responses)) if responses else None,
    "total_liked": sum(1 for response in responses if response.liked),
    "total_shared": sum(1 for response in responses if response.shared),
    "label_metrics": label_metrics,
  }


def build_participant_row(submit_payload: SubmitPayload, metrics: dict[str, Any], user_id: str) -> dict[str, Any]:
  participant = submit_payload.participant
  survey_start = submit_payload.survey_start_time or submit_payload.submitted_at
  try:
    start_dt = parse_iso_datetime(survey_start)
    hour_of_day = start_dt.astimezone().hour
  except ValueError:
    hour_of_day = None
  total_duration_minutes = round(submit_payload.total_time_ms / 60000, 2) if submit_payload.total_time_ms else None
  device = submit_payload.device
  return {
    "session_id": submit_payload.session_id,
    "user_id": user_id,
    "submitted_at": submit_payload.submitted_at,
    "survey_start_time": survey_start,
    "total_duration_minutes": total_duration_minutes,
    "hour_of_day": hour_of_day,
    "name": participant.name,
    "email": participant.email,
    "age": participant.age,
    "gender": participant.gender,
    "ai_frequency": participant.ai_frequency,
    "ai_confidence": participant.ai_confidence,
    "attention_check_passed": submit_payload.attention_check_passed,
    "total_images": metrics["total_images"],
    "total_correct": metrics["total_correct"],
    "overall_accuracy": metrics["overall_accuracy"],
    "ai_images": metrics["ai_images"],
    "ai_correct": metrics["ai_correct"],
    "ai_detection_rate": metrics["ai_detection_rate"],
    "real_images": metrics["real_images"],
    "real_correct": metrics["real_correct"],
    "real_detection_rate": metrics["real_detection_rate"],
    "nolabel_accuracy": metrics["nolabel_accuracy"],
    "label_0_1_accuracy":  metrics["label_0_1_accuracy"],
    "label_0_25_accuracy": metrics["label_0_25_accuracy"],
    "label_0_5_accuracy": metrics["label_0_5_accuracy"],
    "label_1_0_accuracy": metrics["label_1_0_accuracy"],
    "label_1_5_accuracy": metrics["label_1_5_accuracy"],
    "avg_dwell_nolabel": metrics["avg_dwell_nolabel"],
    "avg_dwell_0_1": metrics["avg_dwell_0_1"],
    "avg_dwell_0_25": metrics["avg_dwell_0_25"],
    "avg_dwell_0_5": metrics["avg_dwell_0_5"],
    "avg_dwell_1_0": metrics["avg_dwell_1_0"],
    "avg_dwell_1_5": metrics["avg_dwell_1_5"],
    "avg_rt_nolabel": metrics["avg_rt_nolabel"],
    "avg_rt_0_1": metrics["avg_rt_0_1"],
    "avg_rt_0_25": metrics["avg_rt_0_25"],
    "avg_rt_0_5": metrics["avg_rt_0_5"],
    "avg_rt_1_0": metrics["avg_rt_1_0"],
    "avg_rt_1_5": metrics["avg_rt_1_5"],
    "avg_label_hover_ms": metrics["avg_label_hover_ms"],
    "avg_zoom_count": metrics["avg_zoom_count"],
    "dprime": compute_dprime(*metrics["_dprime_inputs"])[0],
    "response_bias": compute_dprime(*metrics["_dprime_inputs"])[1],
    # SDT per label condition (shared FA rate from real images)
    **{
      f"dprime_{k}": compute_dprime(hr, metrics["_fa_rate"])[0]
      for k, hr in metrics["_cond_hit_rates"].items()
    },
    **{
      f"bias_{k}": compute_dprime(hr, metrics["_fa_rate"])[1]
      for k, hr in metrics["_cond_hit_rates"].items()
    },
    # Label nudge / compliance
    "compliance_nolabel": metrics["compliance_nolabel"],
    "compliance_0_1":  metrics["compliance_0_1"],
    "compliance_0_25": metrics["compliance_0_25"],
    "compliance_0_5":  metrics["compliance_0_5"],
    "compliance_1_0":  metrics["compliance_1_0"],
    "compliance_1_5":  metrics["compliance_1_5"],
    "nudge_0_1":  metrics["nudge_0_1"],
    "nudge_0_25": metrics["nudge_0_25"],
    "nudge_0_5":  metrics["nudge_0_5"],
    "nudge_1_0":  metrics["nudge_1_0"],
    "nudge_1_5":  metrics["nudge_1_5"],
    # Efficiency and consistency
    "ies_overall": metrics["ies_overall"],
    "rt_sd": metrics["rt_sd"],
    # Learning effect
    "first_half_accuracy":  metrics["first_half_accuracy"],
    "second_half_accuracy": metrics["second_half_accuracy"],
    "learning_effect": metrics["learning_effect"],
    # Revisit rates per condition
    "avg_revisits_nolabel": metrics["avg_revisits_nolabel"],
    "avg_revisits_0_1":  metrics["avg_revisits_0_1"],
    "avg_revisits_0_25": metrics["avg_revisits_0_25"],
    "avg_revisits_0_5":  metrics["avg_revisits_0_5"],
    "avg_revisits_1_0":  metrics["avg_revisits_1_0"],
    "avg_revisits_1_5":  metrics["avg_revisits_1_5"],
    "avg_revisits_post_verdict": metrics["avg_revisits_post_verdict"],
    "verdict_change_rate": metrics["verdict_change_rate"],
    "total_liked": metrics["total_liked"],
    "total_shared": metrics["total_shared"],
    "awareness_response": submit_payload.awareness_response,
    "max_scroll_depth_pct": submit_payload.max_scroll_depth_pct,
    "device_type": device.device_type,
    "browser": device.browser,
    "screen_width": device.screen_width,
    "viewport_width": device.viewport_width,
  }


def build_response_rows(submit_payload: SubmitPayload, user_id: str) -> list[dict[str, Any]]:
  device = submit_payload.device
  rows = []
  for response in submit_payload.responses:
    rows.append(
      {
        "session_id": submit_payload.session_id,
        "user_id": user_id,
        "submitted_at": submit_payload.submitted_at,
        "image_position_in_feed": response.image_position_in_feed,
        "image_id": response.image_id,
        "category_id": response.category_id,
        "image_type": response.image_type,
        "is_ai": response.is_ai,
        "label_size_pct": response.label_size_pct,
        "label_position": response.label_position,
        "label_type": response.label_type,
        "category_folder": response.category_folder,
        "participant_verdict": response.participant_verdict,
        "is_correct": response.is_correct,
        "reason_text": response.reason_text,
        "dwell_ms": response.dwell_ms,
        "response_time_ms": response.response_time_ms,
        "scroll_revisits": response.scroll_revisits,
        "revisit_scroll_up": response.revisit_scroll_up,
        "revisit_scroll_down": response.revisit_scroll_down,
        "label_hover_ms": response.label_hover_ms,
        "label_noticed": bool(response.label_hover_ms > 200 and response.image_type == "ai_labeled"),
        # label_compliance: did participant say "AI Modified" for this AI image?
        # For ai_labeled: did the label nudge them? For ai_nolabel: baseline behavior.
        "label_compliance": bool(response.is_ai and response.participant_verdict == "ai_modified"),
        "revisits_post_verdict": response.revisits_post_verdict,
        "revisit_scroll_up_post": response.revisit_scroll_up_post,
        "revisit_scroll_down_post": response.revisit_scroll_down_post,
        "verdict_changed": response.verdict_changed,
        "verdict_change_count": response.verdict_change_count,
        "zoom_count": response.zoom_count,
        "image_load_time_ms": response.image_load_time_ms,
        "liked": response.liked,
        "shared": response.shared,
        "share_count": response.shared_with_count,
        "device_type": device.device_type,
        "browser": device.browser,
        "screen_width": device.screen_width,
        "viewport_width": device.viewport_width,
      }
    )
  return rows


def build_spot_check_row(submit_payload: SubmitPayload, user_id: str) -> dict[str, Any]:
  device = submit_payload.device
  spot = submit_payload.spot_check
  ground_truth_has_label = spot.image_type == "ai_labeled"
  is_correct = (
    spot.participant_answer == ground_truth_has_label
    if spot.participant_answer is not None
    else None
  )
  fast_guess_flag = bool(
    spot.participant_answer is True
    and round(spot.label_size_pct, 2) in FAST_GUESS_LABEL_SIZES
    and spot.response_time_ms is not None
    and spot.response_time_ms < FAST_GUESS_MS_THRESHOLD
  )
  return {
    "session_id": submit_payload.session_id,
    "user_id": user_id,
    "submitted_at": submit_payload.submitted_at,
    "image_id": spot.image_id,
    "category_id": spot.category_id,
    "category_folder": spot.category_folder,
    "image_type": spot.image_type,
    "is_ai": spot.is_ai,
    "label_size_pct": spot.label_size_pct,
    "label_position": spot.label_position,
    "label_type": spot.label_type,
    "ground_truth_has_label": ground_truth_has_label,
    "participant_answer": spot.participant_answer,
    "is_correct": is_correct,
    "fast_guess_flag": fast_guess_flag,
    "dwell_ms": spot.dwell_ms,
    "response_time_ms": spot.response_time_ms,
    "image_load_time_ms": spot.image_load_time_ms,
    "label_hover_ms": spot.label_hover_ms,
    "device_type": device.device_type,
    "browser": device.browser,
    "screen_width": device.screen_width,
    "viewport_width": device.viewport_width,
  }


def build_session_images(session_id: str) -> list[dict[str, Any]]:
  manifest = load_manifest()
  rng = random.Random(session_id)
  selected_rows: list[dict[str, Any]] = []

  for category_id in CATEGORIES:
    category_rows = manifest[manifest["category_id"] == category_id]
    if category_rows.empty:
      raise HTTPException(status_code=500, detail=f"No manifest rows found for {category_id}")

    eligible_rows = category_rows[category_rows["image_type"].isin(["real", "ai_nolabel", "ai_labeled"])]
    if eligible_rows.empty:
      raise HTTPException(status_code=500, detail=f"No eligible rows found for {category_id}")

    chosen = eligible_rows.iloc[rng.randrange(len(eligible_rows))]
    selected_rows.append(as_image_object(chosen))

  rng.shuffle(selected_rows)
  return selected_rows


def build_spot_check_image(session_id: str) -> dict[str, Any]:
  """
  Picks the single post-feed "can you spot a label" test image for a session.

  Stratified by label size: shuffle the 6 size buckets (0%, 0.1%, 0.25%,
  0.5%, 1%, 1.5%) with a session-seeded RNG, then take the first bucket that
  has any eligible image in the manifest. This keeps per-bucket sample sizes
  roughly even across the whole participant pool (needed for a clean
  detection-rate-vs-size curve) while staying deterministic per session, so
  reloading the page can't reroll a different image.

  This is drawn independently of the participant's own 10-image feed -- it
  is fine (and expected) for the spot-check image to repeat one they already
  saw in their feed; nothing is excluded here.
  """
  manifest = load_manifest()
  rng = random.Random(f"{session_id}:spot_check")

  buckets = list(LABEL_SIZES)
  rng.shuffle(buckets)

  for size in buckets:
    if size == 0.0:
      eligible = manifest[manifest["image_type"].isin(["real", "ai_nolabel"])]
    else:
      eligible = manifest[(manifest["image_type"] == "ai_labeled") & (manifest["label_size_pct"] == size)]
    if not eligible.empty:
      chosen = eligible.iloc[rng.randrange(len(eligible))]
      return as_image_object(chosen)

  # Fallback (should never trigger with a non-empty manifest, kept as a
  # guard against a misconfigured/empty dataset).
  if manifest.empty:
    raise HTTPException(status_code=500, detail="No images available for spot check")
  chosen = manifest.iloc[rng.randrange(len(manifest))]
  return as_image_object(chosen)


def get_csv_response(csv_path: Path, filename: str):
  if not csv_path.exists():
    raise HTTPException(status_code=404, detail="CSV export not found")
  return FileResponse(csv_path, media_type="text/csv", filename=filename)


def build_auth_response(user: dict[str, Any]) -> dict[str, Any]:
  token = create_token(str(user["user_id"]), str(user["email"]), str(user.get("name") or ""))
  return {
    "token": token,
    "user_id": user["user_id"],
    "name": user.get("name", ""),
    "email": user["email"],
    "roll_no": user.get("roll_no", ""),
    "study_completed": bool(user.get("study_completed", False)),
  }


def build_notification_payload(notification: dict[str, Any]) -> dict[str, Any]:
  payload = dict(notification)
  notif_id = payload.get("notif_id") or payload.get("id")
  payload["notif_id"] = notif_id
  payload["id"] = notif_id
  from_user = get_user_by_id(str(notification.get("from_user_id") or ""))
  payload["from_name"] = notification.get("from_name") or (from_user.get("name") if from_user else "")
  payload["from_email"] = notification.get("from_email") or (from_user.get("email") if from_user else "")
  payload["image_thumbnail_url"] = notification.get("image_thumbnail_url") or notification.get("image_url")
  return payload


def build_wall_post(post: dict[str, Any], current_user_id: str) -> dict[str, Any]:
  shared_by = get_user_by_id(str(post.get("shared_by_user_id") or ""))
  likes = post.get("likes") or []
  return {
    **post,
    "shared_by_name": post.get("shared_by_name") or (shared_by.get("name") if shared_by else ""),
    "shared_by_email": post.get("shared_by_email") or (shared_by.get("email") if shared_by else ""),
    "like_count": len(likes),
    "liked_by_me": current_user_id in likes,
  }


def queue_notification(recipient_email: str, notification: dict[str, Any]) -> None:
  def _mutate(notifications: dict[str, Any]) -> None:
    bucket = get_notification_bucket(notifications, recipient_email)
    bucket.append(notification)
    notifications[recipient_email] = bucket

  update_json(NOTIFICATIONS_JSON, {}, _mutate)


# --- Batched "share" emails -------------------------------------------------
# If the same sender shares several posts with the same recipient in quick
# succession, we don't want one email per share. We debounce per
# (sharer_id, recipient_id) pair: every new share resets a short timer; when
# the timer finally fires (no new shares from that sharer to that recipient
# for SHARE_EMAIL_BATCH_SECONDS), we send exactly one email summarizing how
# many posts were shared since the last email. A different sharer to the
# same recipient gets their own independent timer/email.
#
# We run 4 uvicorn workers (separate processes, see Procfile), so an
# in-memory dict + threading.Timer is NOT enough on its own: if 3 shares to
# the same recipient land on 2 different worker processes, each process
# starts its own "private" timer with no idea the other exists, and both
# eventually fire -> 2 emails instead of 1. We fix this the same way
# email_service.py fixes cross-worker rate limiting: the batch's count and
# a per-update "token" live in a shared JSON file (via update_json's
# FileLock-protected read-modify-write). Every queued share writes a fresh
# token; a timer only sends if, when it fires, the file's token still
# matches the one it was scheduled with -- i.e. no later share (handled by
# this or any other worker) has come in since. Only the timer tied to the
# truly-last share in the batch will ever see a match, so exactly one email
# goes out, no matter which worker(s) handled the individual /api/social/
# share requests.
SHARE_EMAIL_BATCH_SECONDS = float(os.getenv("SHARE_EMAIL_BATCH_SECONDS", "120"))
_share_email_timers: dict[str, threading.Timer] = {}
_share_email_timers_lock = threading.Lock()


def _flush_share_email(key: str, token: str) -> None:
  with _share_email_timers_lock:
    _share_email_timers.pop(key, None)

  def _claim(pending: dict[str, Any]) -> dict[str, Any] | None:
    entry = pending.get(key)
    if not entry or entry.get("token") != token:
      # A later share (this worker or another) reset the batch after this
      # timer was scheduled -- that share's own timer owns sending it.
      return None
    pending.pop(key, None)
    return entry

  entry = update_json(PENDING_SHARE_EMAILS_JSON, {}, _claim)
  if not entry:
    return

  recipient = get_user_by_id(entry["recipient_id"])
  study_completed = bool(recipient.get("study_completed")) if recipient else entry["recipient_study_completed"]
  try:
    send_share_email(
      to_email=entry["recipient_email"],
      recipient_name=entry["recipient_name"],
      sharer_name=entry["sharer_name"],
      study_completed=study_completed,
      feed_caption=entry["latest_caption"],
      share_count=entry["count"],
      study_link=STUDY_LINK,
    )
  except Exception as exc:
    print(f"Batched share email failed: {exc}")


def queue_share_email(
  sharer_id: str,
  sharer_name: str,
  recipient_id: str,
  recipient_email: str,
  recipient_name: str,
  recipient_study_completed: bool,
  feed_caption: str,
) -> None:
  key = f"{sharer_id}:{recipient_id}"
  token = str(uuid.uuid4())

  def _mutate(pending: dict[str, Any]) -> None:
    entry = pending.get(key) or {
      "sharer_name": sharer_name,
      "recipient_id": recipient_id,
      "recipient_email": recipient_email,
      "recipient_name": recipient_name,
      "recipient_study_completed": recipient_study_completed,
      "count": 0,
      "latest_caption": "",
    }
    entry["count"] += 1
    entry["recipient_study_completed"] = recipient_study_completed
    if feed_caption:
      entry["latest_caption"] = feed_caption
    entry["token"] = token
    pending[key] = entry

  update_json(PENDING_SHARE_EMAILS_JSON, {}, _mutate)

  with _share_email_timers_lock:
    existing_timer = _share_email_timers.get(key)
    if existing_timer is not None:
      existing_timer.cancel()
    timer = threading.Timer(SHARE_EMAIL_BATCH_SECONDS, _flush_share_email, args=(key, token))
    timer.daemon = True
    _share_email_timers[key] = timer
    timer.start()


def apply_share_to_response_rows(rows: list[dict[str, Any]], image_id: str, shared_with_count: int, share_recipients: list[str], wall_likes: int) -> list[dict[str, Any]]:
  updated_rows = []
  recipients_text = ",".join(share_recipients)
  for row in rows:
    if row.get("image_id") == image_id:
      row = {
        **row,
        "shared": True,
        "shared_with_count": shared_with_count,
        "share_recipients": recipients_text,
        "community_wall_likes": wall_likes,
      }
    updated_rows.append(row)
  return updated_rows


def auth_start(payload: AuthStartPayload) -> dict[str, Any]:
  normalized = normalize_email(payload.email)
  users = load_user_store()
  existing = users.get(normalized)
  user = upsert_user(payload.email, payload.name, payload.roll_no)
  otp, _emailed = queue_otp(user)
  response = {
    "message": "OTP sent",
    "study_completed": bool(user.get("study_completed", False)),
    "existing_user": existing is not None,
  }
  if is_dev_mode():
    response["dev_otp"] = otp
  return response


@app.post("/api/auth/register")
def auth_register(payload: AuthStartPayload) -> dict[str, Any]:
  return auth_start(payload)


@app.get("/api/auth/check-email")
def auth_check_email(email: str) -> dict[str, Any]:
  normalized = normalize_email(email)
  users = load_user_store()
  return {"exists": normalized in users}


@app.post("/api/auth/login")
def auth_login(payload: AuthStartPayload) -> dict[str, Any]:
  return auth_start(payload)


@app.post("/api/auth/verify")
def auth_verify(payload: AuthVerifyPayload) -> dict[str, Any]:
  email = normalize_email(payload.email)
  verified_user: dict[str, Any] = {}

  def _mutate(users: dict[str, Any]) -> None:
    user = users.get(email)
    if not user:
      raise HTTPException(status_code=404, detail="User not found")

    stored_otp = str(user.get("otp") or "")
    otp_expires_at = str(user.get("otp_expires_at") or "")
    if not stored_otp or not otp_expires_at:
      raise HTTPException(status_code=400, detail="OTP expired or not requested")
    if payload.otp.strip() != stored_otp:
      raise HTTPException(status_code=400, detail="Invalid OTP")
    if parse_iso_datetime(otp_expires_at) < now_utc():
      raise HTTPException(status_code=400, detail="OTP expired")

    user["otp"] = ""
    user["otp_expires_at"] = ""
    users[email] = user
    verified_user.update(user)

  update_json(USERS_JSON, {}, _mutate)
  return build_auth_response(verified_user)


@app.get("/api/auth/me")
def auth_me(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  return {
    "user_id": current_user["user_id"],
    "email": current_user["email"],
    "name": current_user.get("name", ""),
    "roll_no": current_user.get("roll_no", ""),
    "study_completed": bool(current_user.get("study_completed", False)),
  }


@app.patch("/api/auth/update-profile")
def auth_update_profile(data: dict, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  email = normalize_email(str(current_user.get("email") or ""))
  name = str(data.get("name") or "").strip()
  roll_no = str(data.get("roll_no") or "").strip()

  def _mutate(users: dict[str, Any]) -> None:
    user = users.get(email)
    if not user:
      raise HTTPException(status_code=404, detail="User not found")
    if name:
      user["name"] = name
    if roll_no:
      user["roll_no"] = roll_no
    users[email] = user

  update_json(USERS_JSON, {}, _mutate)
  return {"ok": True}


@app.post("/api/auth/heartbeat")
def auth_heartbeat(payload: HeartbeatPayload, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, str]:
  email = normalize_email(str(current_user.get("email") or ""))

  def _mutate(users: dict[str, Any]) -> None:
    user = users.get(email)
    if user:
      user["last_active"] = iso_now()
      if payload.device_info:
        user["device_info"] = payload.device_info
      users[email] = user

  update_json(USERS_JSON, {}, _mutate)
  return {"status": "ok"}


@app.get("/api/users/search")
def search_users(q: str = Query("", max_length=100), current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  query = q.strip().lower()
  users = load_user_store()
  results = []
  for user in users.values():
    if str(user.get("user_id") or "") == str(current_user.get("user_id") or ""):
      continue
    name = str(user.get("name") or "")
    email = str(user.get("email") or "")
    roll_no = str(user.get("roll_no") or "")
    if not query or query in name.lower() or query in email.lower() or query in roll_no.lower():
      online = user_is_online(user)
      results.append({
        "user_id": user["user_id"],
        "name": name,
        "email": email,
        "roll_no": roll_no,
        "online": online,
        "presence": "Online" if online else presence_label(user),
        "last_active": user.get("last_active", ""),
      })

  results.sort(key=lambda item: item.get("last_active") or "", reverse=True)
  results.sort(key=lambda item: 0 if item["online"] else 1)
  return {"results": results[:50]}


@app.get("/api/session")
def create_session(
  request: Request,
  current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
  if current_user.get("study_completed"):
    raise HTTPException(status_code=403, detail="Study already completed")

  session_id = str(uuid.uuid4())
  images = build_session_images(session_id)

  email = normalize_email(str(current_user.get("email") or ""))

  def _mutate(users: dict[str, Any]) -> None:
    if email in users:
      users[email]["session_count"] = int(users[email].get("session_count") or 0) + 1

  update_json(USERS_JSON, {}, _mutate)

  return {"session_id": session_id, "images": images, "user_id": current_user["user_id"]}


@app.get("/api/spot-image")
def spot_image(session_id: str = Query(..., min_length=1), current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  _ = current_user
  image = build_spot_check_image(session_id)
  return {"session_id": session_id, "image": image}


@app.post("/api/social/share")
def social_share(payload: SocialSharePayload, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  users = load_user_store()
  shared_post_id = str(uuid.uuid4())
  recipient_ids = []
  recipient_emails = []

  sharer_verdict = payload.sharer_verdict or payload.participant_verdict

  for user_id in payload.share_with_user_ids:
    recipient = get_user_by_id(user_id)
    if not recipient:
      continue
    recipient_ids.append(str(recipient["user_id"]))
    recipient_emails.append(str(recipient["email"]))
    notif_id = str(uuid.uuid4())
    queue_notification(
      str(recipient["email"]),
      {
        "id": notif_id,
        "notif_id": notif_id,
        "from_user_id": current_user["user_id"],
        "from_name": current_user.get("name", ""),
        "from_email": current_user.get("email", ""),
        "type": "share",
        "post_id": shared_post_id,
        "feed_caption": payload.feed_caption,
        "image_url": payload.image_url,
        "image_thumbnail_url": payload.image_url,
        "read": False,
        "created_at": iso_now(),
      },
    )

    thread_id = thread_key(str(current_user["user_id"]), str(recipient["user_id"]))
    append_message(
      thread_id,
      {
        "msg_id": str(uuid.uuid4()),
        "from_user_id": current_user["user_id"],
        "to_user_id": recipient["user_id"],
        "type": "share",
        "post_id": shared_post_id,
        "image_url": payload.image_url,
        "feed_caption": payload.feed_caption,
        "timestamp": iso_now(),
      },
    )

    # In dev mode, skip the email pipeline entirely -- the share already
    # shows up in-app (notification + message above), so there's no need to
    # queue/debounce an email that would just get logged and discarded.
    if not is_dev_mode():
      queue_share_email(
        sharer_id=str(current_user["user_id"]),
        sharer_name=current_user.get("name", ""),
        recipient_id=str(recipient["user_id"]),
        recipient_email=str(recipient["email"]),
        recipient_name=str(recipient.get("name", "")),
        recipient_study_completed=bool(recipient.get("study_completed")),
        feed_caption=payload.feed_caption or "",
      )

  shared_post = {
    "post_id": shared_post_id,
    "shared_by_user_id": current_user["user_id"],
    "shared_by_name": current_user.get("name", ""),
    "shared_by_email": current_user.get("email", ""),
    "image_id": payload.image_id,
    "image_url": payload.image_url,
    "feed_caption": payload.feed_caption,
    "feed_source_tag": payload.feed_source_tag,
    "shared_at": iso_now(),
    "likes": [],
    "shared_with": recipient_emails,
    "shared_with_user_ids": recipient_ids,
    "participant_verdict_at_share_time": sharer_verdict,
    "category_id": payload.category_id,
  }

  def _append_post(shared_posts: list[dict[str, Any]]) -> None:
    shared_posts.append(shared_post)

  update_json(SHARED_POSTS_JSON, [], _append_post)

  return {
    "status": "ok",
    "post_id": shared_post_id,
    "shared_with_count": len(recipient_ids),
    "recipient_count": len(recipient_ids),
    "shared_with_user_ids": recipient_ids,
  }


@app.get("/api/social/wall")
def social_wall(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  if not current_user.get("study_completed"):
    raise HTTPException(status_code=403, detail="Study not completed")
  shared_posts = load_shared_posts()
  sorted_posts = sorted(shared_posts, key=lambda post: post.get("shared_at", ""), reverse=True)
  return {"posts": [build_wall_post(post, str(current_user["user_id"])) for post in sorted_posts]}


@app.post("/api/social/like")
def social_like(payload: LikePayload, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  user_id = str(current_user["user_id"])
  result: dict[str, Any] = {}

  def _mutate(shared_posts: list[dict[str, Any]]) -> None:
    for post in shared_posts:
      if post.get("post_id") == payload.post_id:
        likes = list(post.get("likes") or [])
        if user_id in likes:
          likes.remove(user_id)
          result["liked"] = False
        else:
          likes.append(user_id)
          result["liked"] = True
        post["likes"] = likes
        post["like_count"] = len(likes)
        result["like_count"] = len(likes)
        return
    raise HTTPException(status_code=404, detail="Post not found")

  update_json(SHARED_POSTS_JSON, [], _mutate)
  return {"liked": result["liked"], "like_count": result["like_count"]}


@app.get("/api/social/notifications")
def social_notifications(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  notifications = load_notifications_store()
  bucket = notifications.get(str(current_user["email"])) or []
  unread = [build_notification_payload(notification) for notification in bucket if not notification.get("read")]
  return {"notifications": unread, "unread_count": len(unread)}


@app.post("/api/social/notifications/read")
def social_notifications_read(payload: NotificationsReadPayload, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  email = str(current_user["email"])
  notification_ids = {notification_id for notification_id in payload.notification_ids if notification_id}
  result: dict[str, Any] = {}

  def _mutate(notifications: dict[str, Any]) -> None:
    bucket = notifications.get(email) or []
    for notification in bucket:
      notif_id = notification.get("notif_id") or notification.get("id")
      if notif_id in notification_ids or notification.get("id") in notification_ids:
        notification["read"] = True
    notifications[email] = bucket
    result["unread_count"] = sum(1 for notification in bucket if not notification.get("read"))

  update_json(NOTIFICATIONS_JSON, {}, _mutate)
  return {"status": "ok", "unread_count": result["unread_count"]}


@app.on_event("startup")
def startup() -> None:
  ensure_runtime_files()


@app.get("/api/health")
def health() -> dict[str, str]:
  return {"status": "ok"}


@app.post("/api/submit")
def submit_study(
  payload: SubmitPayload,
  current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
  user_id = str(current_user["user_id"])

  # Guard: prevent duplicate submissions
  users = load_user_store()
  if users.get(current_user["email"], {}).get("study_completed"):
    raise HTTPException(status_code=409, detail="Study already submitted.")

  metrics = compute_metrics(payload)
  participant_row = build_participant_row(payload, metrics, user_id)
  response_rows = build_response_rows(payload, user_id)
  spot_check_row = build_spot_check_row(payload, user_id)

  ensure_runtime_files()
  append_row(PARTICIPANTS_CSV, participant_row, PARTICIPANT_COLUMNS)
  if response_rows:
    with _lock_for(RESPONSES_CSV):
      pd.DataFrame(response_rows, columns=RESPONSES_COLUMNS).to_csv(
        RESPONSES_CSV, mode="a", index=False, header=False
      )
  if spot_check_row.get("image_id"):
    append_row(SPOT_CHECKS_CSV, spot_check_row, SPOT_CHECK_COLUMNS)

  # Mark user as completed
  email = current_user["email"]

  def _mark_completed(users: dict[str, Any]) -> None:
    if email in users:
      users[email]["study_completed"] = True
      users[email]["completed_at"] = payload.submitted_at

  update_json(USERS_JSON, {}, _mark_completed)

  return {
    "status": "ok",
    "session_id": payload.session_id,
    "overall_accuracy": metrics.get("overall_accuracy"),
    "ai_detection_rate": metrics.get("ai_detection_rate"),
    "real_detection_rate": metrics.get("real_detection_rate"),
  }


@app.post("/api/dropout")
def record_dropout(payload: DropoutPayload, request: Request) -> dict[str, str]:
  user_id = ""
  auth_header = request.headers.get("authorization") or ""
  if auth_header.startswith("Bearer "):
    token_payload = verify_token(auth_header.split(" ", 1)[1].strip())
    if token_payload:
      user_id = str(token_payload.get("sub") or "")
  append_row(
    DROPOUTS_CSV,
    {
      "session_id": payload.session_id,
      "user_id": user_id,
      "dropped_at_page": payload.dropped_at_page,
      "images_seen_count": payload.images_seen,
      "timestamp": iso_now(),
    },
    DROPOUT_COLUMNS,
  )
  return {"status": "ok"}


@app.get("/api/messages")
def list_message_threads(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  messages = load_messages_store()
  user_id = str(current_user["user_id"])
  threads = []
  for thread_id, bucket in messages.items():
    if user_id not in thread_id:
      continue
    left, _, right = thread_id.partition("_")
    other_id = right if left == user_id else left
    other_user = get_user_by_id(other_id)
    unread = sum(1 for message in bucket if message.get("from_user_id") != user_id and not message.get("read"))
    last_message = bucket[-1] if bucket else None
    threads.append({
      "thread_id": thread_id,
      "other_user_id": other_id,
      "other_name": other_user.get("name") if other_user else "",
      "other_email": other_user.get("email") if other_user else "",
      "online": user_is_online(other_user) if other_user else False,
      "unread_count": unread,
      "last_message": last_message,
    })
  threads.sort(key=lambda item: (item.get("last_message") or {}).get("timestamp", ""), reverse=True)
  return {"threads": threads, "unread_count": sum(thread["unread_count"] for thread in threads)}


@app.get("/api/messages/{thread_id}")
def get_message_thread(thread_id: str, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  user_id = str(current_user["user_id"])
  if user_id not in thread_id:
    raise HTTPException(status_code=403, detail="Not allowed")
  result: dict[str, Any] = {}

  def _mutate(messages: dict[str, Any]) -> None:
    bucket = messages.get(thread_id) or []
    for message in bucket:
      if message.get("from_user_id") != user_id:
        message["read"] = True
    messages[thread_id] = bucket
    result["bucket"] = bucket

  update_json(MESSAGES_JSON, {}, _mutate)
  return {"thread_id": thread_id, "messages": result["bucket"]}


@app.post("/api/messages/{thread_id}")
def send_message_thread(thread_id: str, payload: MessageSendPayload, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
  user_id = str(current_user["user_id"])
  if user_id not in thread_id:
    raise HTTPException(status_code=403, detail="Not allowed")
  text = payload.text.strip()
  if not text:
    raise HTTPException(status_code=400, detail="Message cannot be empty")
  message = {
    "msg_id": str(uuid.uuid4()),
    "from_user_id": user_id,
    "type": "text",
    "text": text,
    "timestamp": iso_now(),
  }
  append_message(thread_id, message)
  return {"status": "ok", "message": message}


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginPayload) -> dict[str, bool]:
  if payload.password != ADMIN_PASSWORD:
    raise HTTPException(status_code=403, detail="Invalid admin password")
  return {"authenticated": True}


@app.get("/api/admin/stats")
def admin_stats(_: None = Depends(require_admin)) -> dict[str, Any]:
  users = load_user_store()
  total_users = len(users)
  completed_studies = sum(1 for user in users.values() if user.get("study_completed"))
  live_participants = sum(1 for user in users.values() if user_is_online(user))

  LABEL_NAMES = ["0% (none)", "0.1%", "0.25%", "0.5%", "1%", "1.5%"]
  RT_COLS = ["avg_rt_nolabel", "avg_rt_0_1", "avg_rt_0_25", "avg_rt_0_5", "avg_rt_1_0", "avg_rt_1_5"]
  DWELL_COLS = ["avg_dwell_nolabel", "avg_dwell_0_1", "avg_dwell_0_25", "avg_dwell_0_5", "avg_dwell_1_0", "avg_dwell_1_5"]
  ACC_COLS = ["nolabel_accuracy", "label_0_1_accuracy", "label_0_25_accuracy", "label_0_5_accuracy", "label_1_0_accuracy", "label_1_5_accuracy"]

  overall_accuracy = None
  ai_detection_rate = None
  real_detection_rate = None
  label_accuracy =[{"label_size_pct": size, "label": LABEL_NAMES[i], "accuracy": None} for i, size in enumerate(LABEL_SIZES)]
  rt_by_label = []
  dwell_by_label = []
  accuracy_by_confidence = []
  demographics: dict[str, Any] = {"gender": [], "total_count": 0, "age_mean": None, "age_min": None, "age_max": None}
  recent_submissions = []

  if PARTICIPANTS_CSV.exists():
    try:
      frame = pd.read_csv(PARTICIPANTS_CSV)
    except Exception:
      frame = pd.DataFrame(columns=PARTICIPANT_COLUMNS)

    if not frame.empty:
      def safe_mean(col: str) -> float | None:
        return float(frame[col].dropna().mean()) if col in frame.columns and frame[col].notna().any() else None

      overall_accuracy = safe_mean("overall_accuracy")
      ai_detection_rate = safe_mean("ai_detection_rate")
      real_detection_rate = safe_mean("real_detection_rate")

      for i, size in enumerate(LABEL_SIZES):
        label_accuracy[i]["accuracy"] = safe_mean(ACC_COLS[i])

      rt_by_label = [{"label": LABEL_NAMES[i], "ms": safe_mean(col)} for i, col in enumerate(RT_COLS)]
      dwell_by_label = [{"label": LABEL_NAMES[i], "ms": safe_mean(col)} for i, col in enumerate(DWELL_COLS)]

      if "ai_confidence" in frame.columns and "overall_accuracy" in frame.columns:
        for conf in range(1, 6):
          subset = frame[frame["ai_confidence"] == conf]["overall_accuracy"].dropna()
          accuracy_by_confidence.append({
            "confidence": conf,
            "accuracy": float(subset.mean()) if len(subset) > 0 else None,
            "count": int(len(subset)),
          })

      if "gender" in frame.columns:
        gender_counts = frame["gender"].dropna().value_counts()
        demographics["gender"] = [{"label": str(k), "count": int(v)} for k, v in gender_counts.items()]
      demographics["total_count"] = len(frame)
      if "age" in frame.columns:
        age_col = frame["age"].dropna()
        if len(age_col) > 0:
          demographics["age_mean"] = round(float(age_col.mean()), 1)
          demographics["age_min"] = int(age_col.min())
          demographics["age_max"] = int(age_col.max())

      recent = frame.tail(10).to_dict(orient="records")
      recent_submissions = [
        {
          "session_id": row.get("session_id"),
          "name": row.get("name"),
          "overall_accuracy": row.get("overall_accuracy"),
          "total_duration_minutes": row.get("total_duration_minutes"),
        }
        for row in recent
      ]

  dropout_total = 0
  dropout_by_page: list[dict[str, Any]] = []
  PAGE_LABELS = {1: "Consent", 2: "Demographics", 3: "Instructions", 4: "Feed", 5: "Spot Check", 6: "Awareness", 7: "Policy"}
  if DROPOUTS_CSV.exists():
    try:
      drop_frame = pd.read_csv(DROPOUTS_CSV)
      if not drop_frame.empty and "dropped_at_page" in drop_frame.columns:
        dropout_total = len(drop_frame)
        page_counts = drop_frame["dropped_at_page"].value_counts().to_dict()
        dropout_by_page = [
          {"page": p, "label": PAGE_LABELS.get(p, f"Page {p}"), "count": int(page_counts.get(p, 0))}
          for p in sorted(PAGE_LABELS.keys()) if page_counts.get(p, 0) > 0
        ]
    except Exception:
      pass

  shared_posts = load_shared_posts()
  messages_store = load_messages_store()
  total_messages = sum(len(thread) for thread in messages_store.values())
  total_wall_likes = sum(len(post.get("likes") or []) for post in shared_posts)

  # -- Extra publishable metrics from responses.csv -------------------------
  per_category_accuracy: list[dict] = []
  feed_position_accuracy: list[dict] = []
  label_noticeability: list[dict] = []
  like_rate_by_type: list[dict] = []
  label_nudge_effect: list[dict] = []
  label_position_accuracy: list[dict] = []
  spot_check_by_size: list[dict] = []
  spot_check_response_time_by_size: list[dict] = []
  spot_check_false_positive_rate: float | None = None
  spot_check_fast_guess_rate: float | None = None
  spot_check_dprime_by_size: list[dict] = []
  spot_check_by_position: list[dict] = []
  spot_check_psychometric: dict[str, Any] | None = None
  spot_check_chi_square: dict[str, Any] | None = None
  spot_check_vs_feed_accuracy: dict[str, Any] | None = None
  demographic_correlations: dict[str, Any] | None = None
  mean_dprime: float | None = None
  mean_response_bias: float | None = None
  attention_pass_rate: float | None = None
  mean_ies: float | None = None
  mean_learning_effect: float | None = None
  completion_rate: float | None = total_users and round(completed_studies / total_users, 4)

  LABEL_NAMES_MAP = {0.0: "0% (none)", 0.1: "0.1%", 0.25: "0.25%", 0.5: "0.5%", 1.0: "1%", 1.5: "1.5%"}
  NUDGE_COLS = [
    ("0.1%",  "compliance_nolabel", "compliance_0_1"),
    ("0.25%", "compliance_nolabel", "compliance_0_25"),
    ("0.5%",  "compliance_nolabel", "compliance_0_5"),
    ("1%",    "compliance_nolabel", "compliance_1_0"),
    ("1.5%",  "compliance_nolabel", "compliance_1_5"),
  ]

  if PARTICIPANTS_CSV.exists():
    try:
      pf = pd.read_csv(PARTICIPANTS_CSV)
      if not pf.empty:
        def _smean(col: str) -> float | None:
          return float(pf[col].dropna().mean()) if col in pf.columns and pf[col].notna().any() else None

        mean_dprime = _smean("dprime")
        mean_response_bias = _smean("response_bias")
        mean_ies = _smean("ies_overall")
        mean_learning_effect = _smean("learning_effect")

        if "attention_check_passed" in pf.columns:
          att = pf["attention_check_passed"].dropna()
          attention_pass_rate = float(att.mean()) if len(att) > 0 else None

        # Label nudge effect aggregated across participants
        if "compliance_nolabel" in pf.columns:
          baseline = pf["compliance_nolabel"].dropna().mean() if pf["compliance_nolabel"].notna().any() else None
          for label, base_col, comp_col in NUDGE_COLS:
            comp_mean = _smean(comp_col)
            nudge = round(comp_mean - baseline, 4) if (comp_mean is not None and baseline is not None) else None
            label_nudge_effect.append({
              "label": label,
              "baseline": round(float(baseline), 4) if baseline is not None else None,
              "compliance": comp_mean,
              "nudge": nudge,
            })
    except Exception:
      pass

  if RESPONSES_CSV.exists():
    try:
      rf = pd.read_csv(RESPONSES_CSV)
      if not rf.empty:
        # Per-category accuracy
        if "category_id" in rf.columns and "is_correct" in rf.columns:
          for cat, grp in rf.groupby("category_id"):
            ai_grp = grp[grp["is_ai"] == True]
            per_category_accuracy.append({
              "category": str(cat),
              "accuracy": round(float(ai_grp["is_correct"].mean()), 4) if len(ai_grp) > 0 else None,
              "n": len(ai_grp),
            })
          per_category_accuracy.sort(key=lambda x: x["category"])

        # Feed position accuracy
        if "image_position_in_feed" in rf.columns and "is_correct" in rf.columns:
          for pos, grp in rf.groupby("image_position_in_feed"):
            feed_position_accuracy.append({
              "position": int(pos),
              "accuracy": round(float(grp["is_correct"].mean()), 4) if len(grp) > 0 else None,
              "n": len(grp),
            })
          feed_position_accuracy.sort(key=lambda x: x["position"])

        # Label noticeability
        if "label_hover_ms" in rf.columns and "image_type" in rf.columns:
          labeled = rf[rf["image_type"] == "ai_labeled"].copy()
          if not labeled.empty and "label_size_pct" in labeled.columns:
            for size, grp in labeled.groupby("label_size_pct"):
              noticed = grp["label_hover_ms"] > 200
              label_noticeability.append({
                "label": LABEL_NAMES_MAP.get(float(size), f"{size}%"),
                "noticeability_rate": round(float(noticed.mean()), 4) if len(noticed) > 0 else None,
                "n": len(grp),
              })

        # Label position accuracy and noticeability
        if "label_position" in rf.columns and "is_correct" in rf.columns:
          labeled_pos = rf[rf["image_type"] == "ai_labeled"].copy()
          for pos, grp in labeled_pos.groupby("label_position"):
            if not pos or str(pos).strip() == "":
              continue
            noticed_rate = None
            if "label_noticed" in grp.columns:
              noticed_rate = round(float(grp["label_noticed"].mean()), 4) if len(grp) > 0 else None
            label_position_accuracy.append({
              "position": str(pos),
              "accuracy": round(float(grp["is_correct"].mean()), 4) if len(grp) > 0 else None,
              "noticeability_rate": noticed_rate,
              "n": len(grp),
            })

        # Like/share rate by image type
        if "liked" in rf.columns and "image_type" in rf.columns:
          for itype, grp in rf.groupby("image_type"):
            like_rate_by_type.append({
              "type": str(itype),
              "like_rate": round(float(grp["liked"].mean()), 4) if len(grp) > 0 else None,
              "share_rate": round(float(grp["shared"].mean()), 4) if "shared" in grp.columns and len(grp) > 0 else None,
              "n": len(grp),
            })
    except Exception:
      pass

  # Post-feed "can you spot a label" single-image test, pooled across all
  # participants (each participant only sees one image, so the detection
  # rate / response-time curve below is built from one data point per
  # participant per label-size bucket).
  if SPOT_CHECKS_CSV.exists():
    try:
      sf = pd.read_csv(SPOT_CHECKS_CSV)
      if not sf.empty and "label_size_pct" in sf.columns and "participant_answer" in sf.columns:
        sf["participant_answer"] = sf["participant_answer"].astype("boolean")
        for size, grp in sf.groupby("label_size_pct"):
          answered = grp["participant_answer"].dropna()
          label = LABEL_NAMES_MAP.get(float(size), f"{size}%")
          n_answered = len(answered)
          successes = int(answered.sum()) if n_answered > 0 else 0
          detection_rate = round(float(answered.mean()), 4) if n_answered > 0 else None
          det_lo, det_hi = wilson_ci(successes, n_answered) if n_answered > 0 else (None, None)

          accuracy_rate = None
          acc_lo, acc_hi = None, None
          if "is_correct" in grp.columns:
            correct = grp["is_correct"].dropna().astype("boolean")
            n_correct_total = len(correct)
            if n_correct_total > 0:
              n_correct = int(correct.astype(float).sum())
              accuracy_rate = round(n_correct / n_correct_total, 4)
              acc_lo, acc_hi = wilson_ci(n_correct, n_correct_total)

          spot_check_by_size.append({
            "label": label,
            "label_size_pct": float(size),
            "detection_rate": detection_rate,
            "detection_rate_ci": [det_lo, det_hi] if det_lo is not None else None,
            "accuracy": accuracy_rate,
            "accuracy_ci": [acc_lo, acc_hi] if acc_lo is not None else None,
            "n": len(grp),
          })

          rt_yes = grp.loc[grp["participant_answer"] == True, "response_time_ms"].dropna() if "response_time_ms" in grp.columns else pd.Series(dtype=float)
          rt_no = grp.loc[grp["participant_answer"] == False, "response_time_ms"].dropna() if "response_time_ms" in grp.columns else pd.Series(dtype=float)
          spot_check_response_time_by_size.append({
            "label": label,
            "label_size_pct": float(size),
            "rt_yes_ms": round(float(rt_yes.mean()), 1) if len(rt_yes) > 0 else None,
            "rt_no_ms": round(float(rt_no.mean()), 1) if len(rt_no) > 0 else None,
            "n_yes": int(len(rt_yes)),
            "n_no": int(len(rt_no)),
          })

        spot_check_by_size.sort(key=lambda x: x["label_size_pct"])
        spot_check_response_time_by_size.sort(key=lambda x: x["label_size_pct"])

        # False positive rate: saying "Yes" when there is in fact no label (size 0%).
        zero_bucket = next((row for row in spot_check_by_size if row["label_size_pct"] == 0.0), None)
        spot_check_false_positive_rate = zero_bucket["detection_rate"] if zero_bucket else None

        if "fast_guess_flag" in sf.columns:
          flags = sf["fast_guess_flag"].dropna().astype("boolean")
          spot_check_fast_guess_rate = round(float(flags.astype(float).mean()), 4) if len(flags) > 0 else None

        # -- Sensitivity (d') per label size, holding the false-alarm rate ---
        # fixed at the 0% bucket's detection rate. This separates genuine
        # detectability from a participant's overall yes-bias, the same way
        # the main feed's d'/criterion already does for AI-detection -- it
        # was previously only computed for the feed task, not this one.
        for row in spot_check_by_size:
          if row["label_size_pct"] == 0.0:
            continue
          dprime, criterion = compute_dprime(row["detection_rate"], spot_check_false_positive_rate)
          spot_check_dprime_by_size.append({
            "label": row["label"],
            "label_size_pct": row["label_size_pct"],
            "dprime": dprime,
            "criterion": criterion,
            "n": row["n"],
          })

        # -- Detection rate by label position (labeled images only) ---------
        if "label_position" in sf.columns:
          labeled_for_pos = sf[sf["label_size_pct"] > 0]
          for pos, pgrp in labeled_for_pos.groupby("label_position"):
            if not pos or str(pos).strip() == "" or str(pos).lower() == "nan":
              continue
            answered = pgrp["participant_answer"].dropna()
            n_answered = len(answered)
            successes = int(answered.sum()) if n_answered > 0 else 0
            det_rate = round(float(answered.mean()), 4) if n_answered > 0 else None
            det_lo, det_hi = wilson_ci(successes, n_answered) if n_answered > 0 else (None, None)
            acc_rate = None
            if "is_correct" in pgrp.columns:
              correct = pgrp["is_correct"].dropna().astype("boolean")
              acc_rate = round(float(correct.astype(float).mean()), 4) if len(correct) > 0 else None
            spot_check_by_position.append({
              "position": str(pos),
              "detection_rate": det_rate,
              "detection_rate_ci": [det_lo, det_hi] if det_lo is not None else None,
              "accuracy": acc_rate,
              "n": len(pgrp),
            })
          spot_check_by_position.sort(key=lambda x: x["position"])

        # -- Psychometric detection-threshold curve --------------------------
        # Row-level fit (not the binned means) over all labeled spot-check
        # images: P(detect) = logistic(b0 + b1 * label_size_pct). Ground
        # truth is always "has label" for these rows, so detecting ==
        # hitting == participant_answer being True -- this is exactly the
        # hit-rate-vs-size curve standard in visibility/psychophysics work,
        # and the headline number ("label X% is the point where half of
        # people notice it") that a publication wants.
        labeled_rows = sf[(sf["label_size_pct"] > 0) & sf["participant_answer"].notna()]
        if len(labeled_rows) >= 8:
          fit_xs = [float(v) for v in labeled_rows["label_size_pct"].tolist()]
          fit_ys = [bool(v) for v in labeled_rows["participant_answer"].tolist()]
          fit = fit_logistic_1d(fit_xs, fit_ys)
          if fit is not None:
            thr50_lo, thr50_hi = bootstrap_threshold_ci(fit_xs, fit_ys, level="threshold_50")
            thr75_lo, thr75_hi = bootstrap_threshold_ci(fit_xs, fit_ys, level="threshold_75")
            spot_check_psychometric = {
              **fit,
              "threshold_50_ci": [thr50_lo, thr50_hi] if thr50_lo is not None else None,
              "threshold_75_ci": [thr75_lo, thr75_hi] if thr75_lo is not None else None,
            }

        # -- Chi-square test of independence: does Yes/No depend on the ------
        # label-size bucket? (i.e. is detection rate actually varying with
        # size, or could the differences across buckets be noise?)
        buckets_for_test = [row for row in spot_check_by_size if row["n"] > 0]
        if len(buckets_for_test) >= 2:
          observed = []
          for row in buckets_for_test:
            ans = sf.loc[sf["label_size_pct"] == row["label_size_pct"], "participant_answer"].dropna()
            yes_n = int(ans.sum())
            observed.append((yes_n, int(len(ans) - yes_n)))
          total_yes = sum(o[0] for o in observed)
          total_no = sum(o[1] for o in observed)
          grand_total = total_yes + total_no
          if grand_total > 0 and total_yes > 0 and total_no > 0:
            stat = 0.0
            for yes_n, no_n in observed:
              row_total = yes_n + no_n
              exp_yes = row_total * total_yes / grand_total
              exp_no = row_total * total_no / grand_total
              if exp_yes > 0:
                stat += (yes_n - exp_yes) ** 2 / exp_yes
              if exp_no > 0:
                stat += (no_n - exp_no) ** 2 / exp_no
            dof = len(observed) - 1
            spot_check_chi_square = {
              "statistic": round(stat, 4),
              "dof": dof,
              "p_value": chi2_sf(stat, dof),
              "n": grand_total,
            }

        # -- Cross-task correlation: spot-check detection vs main-feed -------
        # accuracy, plus demographic correlations. Tests whether the people
        # who are better at literally spotting a label also do better at
        # the real-vs-AI judgment itself, and whether age/AI-familiarity
        # predict either outcome.
        if "is_correct" in sf.columns and PARTICIPANTS_CSV.exists():
          try:
            pf_join = pd.read_csv(PARTICIPANTS_CSV)
            needed_cols = {"session_id", "overall_accuracy", "age", "ai_frequency", "ai_confidence"}
            if not pf_join.empty and needed_cols.issubset(pf_join.columns) and "session_id" in sf.columns:
              merged = sf[["session_id", "is_correct"]].dropna(subset=["is_correct"]).merge(
                pf_join[list(needed_cols)], on="session_id", how="inner",
              )
              merged["is_correct"] = merged["is_correct"].astype("boolean").astype(float)
              if not merged.empty:
                detected = merged.loc[merged["is_correct"] == 1.0, "overall_accuracy"].dropna()
                missed = merged.loc[merged["is_correct"] == 0.0, "overall_accuracy"].dropna()
                spot_check_vs_feed_accuracy = {
                  "mean_accuracy_when_detected": round(float(detected.mean()), 4) if len(detected) > 0 else None,
                  "mean_accuracy_when_missed": round(float(missed.mean()), 4) if len(missed) > 0 else None,
                  "n_detected": int(len(detected)),
                  "n_missed": int(len(missed)),
                  "correlation": pearson_with_p(merged["is_correct"].tolist(), merged["overall_accuracy"].tolist()),
                }

                # Likert-as-interval Pearson correlation -- the standard, if
                # imperfect, approximation used for short ordinal scales.
                demographic_correlations = {
                  "age_vs_accuracy": pearson_with_p(merged["age"].tolist(), merged["overall_accuracy"].tolist()),
                  "ai_frequency_vs_accuracy": pearson_with_p(merged["ai_frequency"].tolist(), merged["overall_accuracy"].tolist()),
                  "ai_confidence_vs_accuracy": pearson_with_p(merged["ai_confidence"].tolist(), merged["overall_accuracy"].tolist()),
                  "age_vs_spot_check_detection": pearson_with_p(merged["age"].tolist(), merged["is_correct"].tolist()),
                  "ai_frequency_vs_spot_check_detection": pearson_with_p(merged["ai_frequency"].tolist(), merged["is_correct"].tolist()),
                  "ai_confidence_vs_spot_check_detection": pearson_with_p(merged["ai_confidence"].tolist(), merged["is_correct"].tolist()),
                }
          except Exception:
            pass
    except Exception:
      pass

  return {
    "total_users": total_users,
    "completed_studies": completed_studies,
    "live_participants": live_participants,
    "completion_rate": completion_rate,
    "overall_accuracy": overall_accuracy,
    "ai_detection_rate": ai_detection_rate,
    "real_detection_rate": real_detection_rate,
    "mean_dprime": mean_dprime,
    "mean_response_bias": mean_response_bias,
    "attention_pass_rate": attention_pass_rate,
    "mean_ies": mean_ies,
    "mean_learning_effect": mean_learning_effect,
    "label_accuracy": label_accuracy,
    "rt_by_label": rt_by_label,
    "dwell_by_label": dwell_by_label,
    "accuracy_by_confidence": accuracy_by_confidence,
    "demographics": demographics,
    "dropout_total": dropout_total,
    "dropout_by_page": dropout_by_page,
    "per_category_accuracy": per_category_accuracy,
    "feed_position_accuracy": feed_position_accuracy,
    "label_noticeability": label_noticeability,
    "label_nudge_effect": label_nudge_effect,
    "label_position_accuracy": label_position_accuracy,
    "spot_check_by_size": spot_check_by_size,
    "spot_check_response_time_by_size": spot_check_response_time_by_size,
    "spot_check_false_positive_rate": spot_check_false_positive_rate,
    "spot_check_fast_guess_rate": spot_check_fast_guess_rate,
    "spot_check_dprime_by_size": spot_check_dprime_by_size,
    "spot_check_by_position": spot_check_by_position,
    "spot_check_psychometric": spot_check_psychometric,
    "spot_check_chi_square": spot_check_chi_square,
    "spot_check_vs_feed_accuracy": spot_check_vs_feed_accuracy,
    "demographic_correlations": demographic_correlations,
    "like_rate_by_type": like_rate_by_type,
    "mean_ies": mean_ies,
    "mean_learning_effect": mean_learning_effect,
    "social_stats": {
      "wall_posts": len(shared_posts),
      "total_messages": total_messages,
      "total_likes": total_wall_likes,
    },
    "recent_submissions": recent_submissions,
  }


@app.get("/api/admin/export/{dataset}")
def admin_export(dataset: str, password: str = Query(...)) -> FileResponse:
  if password != ADMIN_PASSWORD:
    raise HTTPException(status_code=403, detail="Invalid admin password")
  if dataset == "responses":
    return get_csv_response(RESPONSES_CSV, "responses.csv")
  if dataset == "participants":
    return get_csv_response(PARTICIPANTS_CSV, "participants.csv")
  if dataset == "dropouts":
    return get_csv_response(DROPOUTS_CSV, "dropouts.csv")
  if dataset == "spot_checks":
    return get_csv_response(SPOT_CHECKS_CSV, "spot_checks.csv")
  raise HTTPException(status_code=404, detail="Unknown dataset")


@app.post("/api/admin/reset")
def admin_reset(_: None = Depends(require_admin)) -> dict[str, str]:
  with _lock_for(PARTICIPANTS_CSV):
    pd.DataFrame(columns=PARTICIPANT_COLUMNS).to_csv(PARTICIPANTS_CSV, index=False)
  with _lock_for(RESPONSES_CSV):
    pd.DataFrame(columns=RESPONSES_COLUMNS).to_csv(RESPONSES_CSV, index=False)
  with _lock_for(DROPOUTS_CSV):
    pd.DataFrame(columns=DROPOUT_COLUMNS).to_csv(DROPOUTS_CSV, index=False)
  with _lock_for(SPOT_CHECKS_CSV):
    pd.DataFrame(columns=SPOT_CHECK_COLUMNS).to_csv(SPOT_CHECKS_CSV, index=False)
  save_json(SHARED_POSTS_JSON, [])
  save_json(NOTIFICATIONS_JSON, {})
  save_json(MESSAGES_JSON, {})
  save_json(USERS_JSON, {})
  save_json(PENDING_SHARE_EMAILS_JSON, {})
  return {"status": "ok"}


# Serve the built React frontend — MUST be last so API routes are matched first
_FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
if _FRONTEND_DIST.exists():
  app.mount("/assets", StaticFiles(directory=str(_FRONTEND_DIST / "assets")), name="assets")

  @app.get("/", response_class=HTMLResponse)
  @app.get("/{full_path:path}", response_class=HTMLResponse)
  def serve_spa(full_path: str = "") -> HTMLResponse:
    index = _FRONTEND_DIST / "index.html"
    return HTMLResponse(index.read_text(encoding="utf-8"))
