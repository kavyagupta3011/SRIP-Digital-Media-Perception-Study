from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)


def is_dev_mode() -> bool:
  return os.getenv("DEV_MODE", "false").strip().lower() in {"1", "true", "yes", "on"}


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
  study_link: str = "http://localhost:5173",
) -> bool:
  if is_dev_mode():
    print(f"DEV MODE — Share email to {to_email} from {sharer_name}")
    return True

  try:
    import resend
    resend.api_key = os.getenv("RESEND_API_KEY", "").strip()
    if not resend.api_key:
      return False

    smtp_email = "notify@digitalmediastudy.online"

    if study_completed:
      subject = f"{sharer_name} shared a post with you"
      body = (
        f"Hi {recipient_name or 'there'},\n\n"
        f"Check out what {sharer_name} shared with you in the SRIP Community Wall: {study_link}\n\n"
        f"Caption: {feed_caption}\n"
      )
    else:
      subject = "Someone shared a post with you on SRIP Study"
      body = (
        f"Hi {recipient_name or 'there'},\n\n"
        f"{sharer_name} shared a post with you in the Digital Media Perception Study.\n"
        f"Complete the study to see it: {study_link}\n"
      )

    resend.Emails.send({
      "from": smtp_email,
      "to": [to_email],
      "subject": subject,
      "text": body,
    })
    return True
  except Exception as exc:
    print(f"Share email failed: {exc}")
    return False
