export const ATTENTION_CHECK_ID = "__attention_check__";

export function getDeviceInfo() {
  const ua = navigator.userAgent || "";
  let deviceType = "desktop";
  if (/Mobi|Android/i.test(ua)) deviceType = "mobile";
  else if (/Tablet|iPad/i.test(ua)) deviceType = "tablet";

  let browser = "Other";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";

  return {
    device_type: deviceType,
    browser,
    screen_width: window.screen?.width || 0,
    screen_height: window.screen?.height || 0,
    viewport_width: window.innerWidth || 0,
    device_info: `${browser}/${deviceType}`
  };
}

export function formatPresence(lastActive) {
  if (!lastActive) return "Offline";
  const last = new Date(lastActive).getTime();
  if (Number.isNaN(last)) return "Offline";
  const diffSec = Math.floor((Date.now() - last) / 1000);
  if (diffSec <= 120) return "Online";
  if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))} min ago`;
  return "Offline";
}

export function isOnline(lastActive) {
  if (!lastActive) return false;
  const last = new Date(lastActive).getTime();
  return !Number.isNaN(last) && Date.now() - last <= 120000;
}

export function buildFeedDisplayItems(images) {
  const items = images.map((image, index) => ({ kind: "image", image, feedIndex: index }));
  if (items.length >= 5) {
    items.splice(5, 0, { kind: "attention", image: null, feedIndex: -1 });
  }
  return items;
}
