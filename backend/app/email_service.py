from __future__ import annotations

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from filelock import FileLock

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)


def is_dev_mode() -> bool:
  return os.getenv("DEV_MODE", "false").strip().lower() in {"1", "true", "yes", "on"}


# -- Cross-worker Resend rate limiting --------------------------------------
#
# Resend's plan caps us at RESEND_MAX_PER_SECOND sends per second. We run 4
# uvicorn workers (separate processes), so an in-memory counter here would be
# wrong: each worker would think it has its own private budget, and the 4 of
# them combined could blow past the real limit without any one of them
# knowing. Instead we keep a tiny shared file of timestamps (one per email
# actually sent) protected by its own FileLock, so every worker is reading
# and writing the same shared "ledger" before it's allowed to send.
RESEND_MAX_PER_SECOND = 2
RESEND_WINDOW_SECONDS = 1.0
# Extra cushion added on top of the bare-minimum wait, so we don't shave it
# so close to the 1-second boundary that clock/measurement jitter between
# us and Resend's own server could still land us just inside their window.
RESEND_SAFETY_MARGIN_SECONDS = 0.2

_store_env = os.getenv("STORE_DIR", "").strip()
_RATE_LIMIT_DIR = Path(_store_env) if _store_env else (Path(__file__).resolve().parent.parent / "data")
_RATE_LIMIT_DIR.mkdir(parents=True, exist_ok=True)
EMAIL_RATE_FILE = _RATE_LIMIT_DIR / "email_send_log.json"
_EMAIL_RATE_LOCK = FileLock(str(EMAIL_RATE_FILE) + ".lock", timeout=10)


def _read_send_timestamps() -> list[float]:
  if not EMAIL_RATE_FILE.exists():
    return []
  try:
    raw = json.loads(EMAIL_RATE_FILE.read_text(encoding="utf-8"))
    return [float(t) for t in raw if isinstance(t, (int, float))]
  except (json.JSONDecodeError, OSError, ValueError):
    return []


def _write_send_timestamps(timestamps: list[float]) -> None:
  EMAIL_RATE_FILE.write_text(json.dumps(timestamps), encoding="utf-8")


def throttle_for_resend_rate_limit() -> None:
  """Block (briefly) until it's safe to send another email without tripping
  Resend's per-second rate limit, accounting for what every worker process
  has sent recently, not just this one.

  Reserves our "slot" in the shared ledger before returning, so the very
  next caller (in this worker or another) sees our send reflected too.
  """
  while True:
    with _EMAIL_RATE_LOCK:
      now = time.monotonic()
      timestamps = [t for t in _read_send_timestamps() if now - t < RESEND_WINDOW_SECONDS]

      if len(timestamps) < RESEND_MAX_PER_SECOND:
        timestamps.append(now)
        _write_send_timestamps(timestamps)
        return

      oldest = min(timestamps)
      wait_seconds = (RESEND_WINDOW_SECONDS - (now - oldest)) + RESEND_SAFETY_MARGIN_SECONDS

    # Sleep outside the lock so other workers/requests aren't blocked while
    # we wait — we'll re-check the ledger fresh once we wake up.
    time.sleep(max(wait_seconds, 0.05))


def send_otp_email(to_email: str, otp: str, name: str) -> bool:
  """Send OTP email. Returns True on success, False on failure."""
  if is_dev_mode():
    print(f"\n{'=' * 40}")
    print(f"DEV MODE — OTP for {to_email}: {otp}")
    print(f"{'=' * 40}\n")
    return True

  try:
    import resend
    resend.api_key = os.getenv("RESEND_API_KEY", "").strip()
    if not resend.api_key:
      print(f"RESEND_API_KEY not set — OTP for {to_email}: {otp}")
      return False

    smtp_email = "otp@digitalmediastudy.online"

    html_body = f"""
    <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #1a1a18;">IIIT Bangalore — Digital Media Perception Study</h2>
    <p>Hi {name or 'there'},</p>
    <p>Your one-time password for the study is:</p>
    <div style="background: #f0f4ff; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #185fa5;">{otp}</span>
    </div>
    <p style="color: #666;">This OTP expires in <strong>10 minutes</strong>.</p>
    <p style="color: #666;">If you did not request this, please ignore this email.</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
    <p style="color: #999; font-size: 12px;">Research Team, IIIT Bangalore</p>
    </body></html>
    """

    throttle_for_resend_rate_limit()
    resend.Emails.send({
      "from": f"SRIP Research Team <{smtp_email}>",
      "to": [to_email],
      "subject": "Your OTP for the Digital Media Perception Study",
      "html": html_body,
    })
    return True
  except Exception as exc:
    print(f"Email send failed: {exc}")
    return False


def send_share_email(
  to_email: str,
  recipient_name: str,
  sharer_name: str,
  study_completed: bool,
  feed_caption: str = "",
  share_count: int = 1,
  study_link: str = "http://localhost:5173",
) -> bool:
  """Send ONE email summarizing how many posts a sharer shared with a recipient.

  Callers should batch multiple shares from the same sharer to the same
  recipient and call this once with the total `share_count`, rather than
  calling it once per share.
  """
  if is_dev_mode():
    print(f"DEV MODE — Share email to {to_email} from {sharer_name} ({share_count} post(s))")
    return True

  try:
    import resend
    resend.api_key = os.getenv("RESEND_API_KEY", "").strip()
    if not resend.api_key:
      return False

    smtp_email = "notify@digitalmediastudy.online"
    post_word = "post" if share_count == 1 else "posts"

    if study_completed:
      subject = (
        f"{sharer_name} shared a post with you" if share_count == 1
        else f"{sharer_name} shared {share_count} posts with you"
      )
      intro_line = f"{sharer_name} shared {share_count} {post_word} with you in the SRIP Community Wall."
      cta_text = "View them here"
      caption_html = f'<p style="color: #666;">Latest caption: {feed_caption}</p>' if feed_caption else ""
      body = (
        f"Hi {recipient_name or 'there'},\n\n"
        f"{intro_line}\n"
        f"View them here: {study_link}\n\n"
        + (f"Latest caption: {feed_caption}\n" if feed_caption else "")
      )
    else:
      subject = (
        "Someone shared a post with you on SRIP Study" if share_count == 1
        else f"Someone shared {share_count} posts with you on SRIP Study"
      )
      intro_line = f"{sharer_name} shared {share_count} {post_word} with you in the Digital Media Perception Study."
      cta_text = f"Complete the study to see {'it' if share_count == 1 else 'them'}"
      caption_html = ""
      body = (
        f"Hi {recipient_name or 'there'},\n\n"
        f"{intro_line}\n"
        f"Complete the study to see {'it' if share_count == 1 else 'them'}: {study_link}\n"
      )

    html_body = f"""
    <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #1a1a18;">IIIT Bangalore — Digital Media Perception Study</h2>
    <p>Hi {recipient_name or 'there'},</p>
    <p>{intro_line}</p>
    {caption_html}
    <p style="margin: 24px 0;">
      <a href="{study_link}" style="background: #185fa5; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">{cta_text}</a>
    </p>
    <p style="color: #666; font-size: 13px;">Or copy this link into your browser: {study_link}</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
    <p style="color: #999; font-size: 12px;">Research Team, IIIT Bangalore</p>
    </body></html>
    """

    throttle_for_resend_rate_limit()
    resend.Emails.send({
      "from": f"SRIP Research Team <{smtp_email}>",
      "to": [to_email],
      "subject": subject,
      "text": body,
      "html": html_body,
    })
    return True
  except Exception as exc:
    print(f"Share email failed: {exc}")
    return False
