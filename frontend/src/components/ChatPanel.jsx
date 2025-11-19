import { useEffect, useMemo, useRef, useState } from "react";
import "./styles/ChatPanel.css";

const formatTime = (timestamp) => {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

const ChatPanel = ({ messages = [], onSend, currentUserId, disabled = false }) => {
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef(null);

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
    [messages]
  );

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [sortedMessages]);

  const handleSend = () => {
    if (!message.trim()) return;
    onSend?.(message);
    setMessage("");
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {sortedMessages.length === 0 && (
          <div className="chat-empty-state">No messages yet. Say hello! 👋</div>
        )}
        {sortedMessages.map((msg) => {
          const isOwn = msg.userId === currentUserId;
          return (
            <div
              key={msg.id}
              className={`chat-message ${isOwn ? "chat-message-own" : ""}`}
            >
              <div className="chat-message-header">
                <span className="chat-sender">{msg.name || "Anonymous"}</span>
                <span className="chat-time">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="chat-text">{msg.message}</div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-container">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled ? "Chat is unavailable in solo mode." : "Type a message..."
          }
          disabled={disabled}
          rows={2}
        />
        <button onClick={handleSend} disabled={disabled || !message.trim()}>
          Send
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;

