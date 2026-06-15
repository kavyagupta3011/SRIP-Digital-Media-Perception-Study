import { Component, useEffect, useState } from "react";

class MessagesErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMsg: "" };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, errorMsg: String(error?.message || error) };
  }
  render() {
    if (this.state.hasError) {
      return (
        <section className="srip-panel mx-auto w-full max-w-4xl p-8 text-center">
          <p className="text-sm font-semibold text-red-600">Messages failed to load</p>
          <p className="mt-1 text-xs text-slate-500">{this.state.errorMsg}</p>
          <button
            type="button"
            className="mt-4 rounded-full bg-slate-900 px-6 py-2 text-sm font-semibold text-white"
            onClick={() => this.setState({ hasError: false, errorMsg: "" })}
          >
            Retry
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

function authHeaders(token, extra = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

function Panel({ children, className = "" }) {
  return <section className={`srip-panel ${className}`}>{children}</section>;
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

function MessageBubble({ message, isMine, onOpenWall }) {
  return (
    <div className={"flex " + (isMine ? "justify-end" : "justify-start")}>
      <div className={"max-w-[75%] rounded-3xl px-4 py-3 text-sm " + (isMine ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-800")}>
        {message.type === "share" ? (
          <>
            <p className={"text-xs font-semibold uppercase tracking-wide mb-2 " + (isMine ? "text-slate-300" : "text-slate-500")}>Shared a post</p>
            {message.image_url ? (
              <img src={message.image_url} alt={message.feed_caption || "Shared post"} className="mb-2 max-h-40 w-full rounded-2xl object-contain" />
            ) : null}
            <p className="mb-2">{message.feed_caption}</p>
            <button
              type="button"
              onClick={onOpenWall}
              className={"rounded-full border px-3 py-1 text-xs font-semibold transition " + (isMine ? "border-slate-500 text-slate-300 hover:bg-slate-700" : "border-slate-200 text-slate-700 hover:bg-slate-50")}
            >
              View Full Post
            </button>
          </>
        ) : (
          <p>{message.text}</p>
        )}
        <p className={"mt-1 text-[11px] " + (isMine ? "text-slate-400" : "text-slate-400")}>
          {isMine ? "You · " : ""}{message.timestamp}
        </p>
      </div>
    </div>
  );
}

function MessagesPageInner({ token, onOpenWall, currentUserId, initialTargetId, onClearTarget }) {
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadThreads = async () => {
    const response = await fetch("/api/messages", { headers: authHeaders(token) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not load messages.");
    setThreads(data.threads || []);
  };

  const loadThread = async (threadId) => {
    const response = await fetch("/api/messages/" + encodeURIComponent(threadId), { headers: authHeaders(token) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not load thread.");
    setMessages(data.messages || []);
    setActiveThread(threadId);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadThreads();
        if (initialTargetId && currentUserId) {
          const sorted = [String(currentUserId), String(initialTargetId)].sort();
          await loadThread(sorted[0] + "_" + sorted[1]);
          if (onClearTarget) onClearTarget();
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const intervalId = window.setInterval(() => {
      loadThreads().catch(() => {});
      if (activeThread) loadThread(activeThread).catch(() => {});
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token, activeThread]);

  const sendMessage = async () => {
    if (!activeThread || !draft.trim()) return;
    const response = await fetch("/api/messages/" + encodeURIComponent(activeThread), {
      method: "POST",
      headers: authHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ text: draft.trim() })
    });
    const data = await response.json();
    if (!response.ok) { alert(data.detail || "Could not send message."); return; }
    setDraft("");
    await loadThread(activeThread);
    await loadThreads();
  };

  const activeThreadData = threads.find((t) => t.thread_id === activeThread);

  if (loading) {
    return <Panel className="mx-auto w-full max-w-4xl p-8 text-center text-sm text-slate-600">Loading messages...</Panel>;
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 pb-20 pt-4 md:grid-cols-[280px_1fr] md:px-6">
      <Panel className="p-4">
        <p className="srip-eyebrow">Messages</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">Conversations</h2>
        <div className="mt-4 space-y-2">
          {threads.length === 0 ? <p className="text-sm text-slate-500">No conversations yet. Reply to someone on the Community Wall to start one.</p> : null}
          {threads.map((thread) => (
            <button
              key={thread.thread_id}
              type="button"
              onClick={() => loadThread(thread.thread_id)}
              className={"flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm " + (activeThread === thread.thread_id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}
            >
              <span>
                <span className="block font-semibold">{thread.other_name || thread.other_email}</span>
                <span className={"block text-xs " + (activeThread === thread.thread_id ? "text-slate-400" : "text-slate-500")}>{thread.online ? "Online" : "Offline"}</span>
              </span>
              {thread.unread_count > 0 ? <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">{thread.unread_count}</span> : null}
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="flex min-h-[28rem] flex-col p-5">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {!activeThread ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-slate-600">No conversation selected</p>
            <p className="text-xs text-slate-400">Go to the Community Wall and tap Reply on a post to start a chat.</p>
          </div>
        ) : (
          <>
            {activeThreadData ? (
              <div className="mb-4 border-b border-slate-100 pb-3">
                <p className="text-sm font-semibold text-slate-900">{activeThreadData.other_name || activeThreadData.other_email}</p>
                <p className="text-xs text-slate-500">{activeThreadData.online ? "Online" : "Offline"}</p>
              </div>
            ) : null}
            <div className="flex-1 space-y-3 overflow-y-auto pr-1">
              {messages.length === 0 ? (
                <p className="text-center text-sm text-slate-400">No messages yet. Say hi!</p>
              ) : null}
              {messages.map((message) => (
                <MessageBubble
                  key={message.msg_id}
                  message={message}
                  isMine={String(message.from_user_id) === String(currentUserId)}
                  onOpenWall={onOpenWall}
                />
              ))}
            </div>
            <div className="mt-4 flex gap-3">
              <input
                className="srip-input flex-1"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Type a message... (Enter to send)"
              />
              <Button onClick={sendMessage} disabled={!draft.trim()}>Send</Button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

export default function MessagesPage(props) {
  return (
    <MessagesErrorBoundary>
      <MessagesPageInner {...props} />
    </MessagesErrorBoundary>
  );
}
