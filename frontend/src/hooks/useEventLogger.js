const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

async function postJSON(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Request failed");
  }
  return response.json();
}

export function useEventLogger({ participantId, sessionId }) {
  const logEvent = (eventType, metadata = {}) => {
    postJSON("/api/events", {
      participant_id: participantId,
      session_id: sessionId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      metadata
    }).catch(() => undefined);
  };

  const createParticipant = async (payload) =>
    postJSON("/api/participants", {
      ...payload,
      session_id: sessionId
    });

  const submitClassification = async (payload) =>
    postJSON("/api/classifications", {
      participant_id: participantId,
      session_id: sessionId,
      ...payload
    });

  const submitRecall = async (payload) =>
    postJSON("/api/recall", {
      participant_id: participantId,
      session_id: sessionId,
      ...payload
    });

  const submitAwareness = async (payload) =>
    postJSON("/api/awareness", {
      participant_id: participantId,
      session_id: sessionId,
      ...payload
    });

  const submitPolicy = async (payload) =>
    postJSON("/api/policy", {
      participant_id: participantId,
      session_id: sessionId,
      ...payload
    });

  return {
    logEvent,
    createParticipant,
    submitClassification,
    submitRecall,
    submitAwareness,
    submitPolicy
  };
}
