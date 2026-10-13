import React, { useCallback, useRef, useState } from "react";
import {
  careRequest,
  Icon,
  IconButton,
  Mark,
  MessageText,
  PageList,
} from "./components.jsx";

export function Conversation({
  hidden,
  home,
  status,
  session,
  draft,
  setDraft,
  attachments,
  setAttachments,
  context,
  setContext,
  execution,
  setExecution,
  busy,
  blocked,
  activity,
  error,
  setError,
  onSend,
  onUpload,
  onSelect,
  onItem,
  onAsk,
}) {
  const [listening, setListening] = useState(false),
    [visibleCount, setVisibleCount] = useState(20);
  const recognition = useRef(null);
  const visibleRef = useCallback(
    (node) => {
      if (node?.hidden) recognition.current?.stop();
    },
    [hidden],
  );
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const messages = (session?.messages || []).filter(
    (message) => message.role !== "tool" && message.content,
  );
  const pending =
    session?.pending.filter(
      (call) => call.write && call.approved === undefined,
    ) || [];
  const records = [
    ...home.assets,
    ...home.memories,
    ...home.tasks,
    ...home.maintenance,
    ...home.incidents,
    ...home.documents,
  ];
  const recordName = (id) => {
    const row = records.find((record) => record.id === id);
    return row?.name || row?.title || row?.symptom || "Selected record";
  };
  function submit() {
    if (blocked || (!draft.trim() && !attachments.length)) return;
    if (listening) recognition.current?.stop();
    const text =
      draft.trim() ||
      "Read this document and file it with the right item in my home. Add the item if needed, using only supported facts.";
    void onSend(
      {
        message: `${text}${context.map((ref) => `\n\n${ref.type} reference: ${ref.id}`).join("")}${attachments.map((doc) => `\n\nDocument reference: ${doc.id}`).join("")}`,
      },
      true,
    );
  }
  function dictate() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const speech = new SpeechRecognition();
    recognition.current = speech;
    speech.lang = navigator.language;
    speech.interimResults = false;
    speech.onresult = (event) =>
      setDraft(
        (previous) =>
          `${previous}${previous ? " " : ""}${event.results[0][0].transcript}`,
      );
    speech.onerror = (event) =>
      setError(
        `Dictation unavailable (${event.error}). You can type your message.`,
      );
    speech.onend = () => setListening(false);
    speech.start();
    setListening(true);
  }
  const hasMessages = messages.length > 0;
  return (
    <main
      hidden={hidden}
      ref={visibleRef}
      className={`conversation ${hasMessages ? "started" : "empty"}`}
      aria-label="Conversation"
    >
      {hasMessages && (
        <div className="chat-toolbar">
          <span>{session?.title?.split("\n")[0]}</span>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setVisibleCount(20);
              void onSelect(null);
            }}
          >
            <Icon name="plus" size={16} /> New chat
          </button>
        </div>
      )}
      {!hasMessages && (
        <div className="conversation-intro">
          <h1>What can I take care of?</h1>
        </div>
      )}
      {hasMessages && (
        <section className="messages" aria-label="Messages" aria-busy={busy}>
          <div className="message-list">
            {messages.length > visibleCount && (
              <button
                className="text-button earlier-messages"
                onClick={() => setVisibleCount(visibleCount + 20)}
              >
                Show earlier messages
              </button>
            )}
            {messages.slice(-visibleCount).map((message, index) => {
              const references =
                message.role === "user"
                  ? [
                      ...message.content.matchAll(
                        /(?:Home item|Document) reference: ([a-f\d-]{36})/g,
                      ),
                    ]
                  : [];
              const text =
                message.role === "user"
                  ? message.content.replace(
                      /\n\n(?:Home item|Document) reference: [a-f\d-]{36}/g,
                      "",
                    )
                  : message.content;
              return (
                <article
                  className={`message ${message.role}`}
                  key={`${session?.id}:${messages.length - Math.min(messages.length, visibleCount) + index}`}
                >
                  {message.role === "assistant" && <Mark size={24} />}
                  <div className="message-body">
                    <span className="sr-only">
                      {message.role === "user" ? "You" : "HomeKeeper"}
                    </span>
                    <MessageText text={text} onItem={onItem} />
                    {references.length > 0 && (
                      <div className="message-references">
                        {references.map((match, i) => (
                          <span key={i}>
                            <Icon
                              name={
                                match[0].startsWith("Document")
                                  ? "file"
                                  : "home"
                              }
                              size={14}
                            />
                            {recordName(match[1])}
                          </span>
                        ))}
                      </div>
                    )}
                    {message.role === "assistant" && (
                      <div className="message-actions">
                        {"speechSynthesis" in window && (
                          <IconButton
                            name="speaker"
                            label="Read response aloud"
                            onClick={() => {
                              window.speechSynthesis.cancel();
                              window.speechSynthesis.speak(
                                new SpeechSynthesisUtterance(text),
                              );
                            }}
                          />
                        )}
                        <button
                          className="text-button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(text);
                            } catch {
                              setError(
                                "Could not copy. Select the response text to copy it manually.",
                              );
                            }
                          }}
                        >
                          Copy
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
            {session?.state === "ready" && session.nextSteps?.length > 0 && (
              <div className="next-steps" aria-label="Suggested next steps">
                {session.nextSteps.map((action, index) => (
                  <button
                    key={index}
                    className="secondary"
                    disabled={blocked}
                    onClick={() => onSend({ message: action })}
                  >
                    {action}
                    <Icon name="arrow" size={16} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
      {!!pending.length && (
        <section className="approval" aria-label="Review changes">
          <h2>
            {pending.some(
              (c) =>
                c.name === "forget_memory" ||
                c.args.status === "cancelled" ||
                (c.args.due_on === null && c.name === "update_maintenance"),
            )
              ? "Confirm this change"
              : "Save to your home?"}
          </h2>
          <PageList items={pending} size={3} label="Proposed changes">
            {(rows) =>
              rows.map((call) => (
                <div className="proposed-change" key={call.id}>
                  <h3>{call.title}</h3>
                  <p>
                    {String(
                      call.args.title ||
                        call.args.name ||
                        call.args.resolution ||
                        call.args.symptom ||
                        recordName(
                          call.args.memory_id ||
                            call.args.task_id ||
                            call.args.maintenance_id ||
                            call.args.document_id,
                        ),
                    )}
                  </p>
                  {call.args.content && <p>{String(call.args.content)}</p>}
                  <details>
                    <summary>Review details</summary>
                    <dl>
                      {Object.entries(call.args)
                        .filter(
                          ([key, value]) =>
                            !["request_id", "expected_revision"].includes(
                              key,
                            ) &&
                            value !== null &&
                            value !== "",
                        )
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>
                              {key.endsWith("_id")
                                ? "For"
                                : key.replaceAll("_", " ")}
                            </dt>
                            <dd>
                              {key.endsWith("_id")
                                ? recordName(value)
                                : key === "cost_minor" &&
                                    Number.isSafeInteger(value) &&
                                    Intl.supportedValuesOf("currency").includes(
                                      call.args.currency,
                                    )
                                  ? new Intl.NumberFormat(undefined, {
                                      style: "currency",
                                      currency: call.args.currency,
                                    }).format(
                                      value /
                                        10 **
                                          new Intl.NumberFormat(undefined, {
                                            style: "currency",
                                            currency: call.args.currency,
                                          }).resolvedOptions()
                                            .maximumFractionDigits,
                                    )
                                  : String(value)}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  </details>
                </div>
              ))
            }
          </PageList>
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => onSend({ decision: true })}
            >
              {pending.length > 1
                ? `Confirm ${pending.length} changes`
                : "Confirm change"}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => onSend({ decision: false })}
            >
              Don’t save
            </button>
          </div>
        </section>
      )}
      <div className="chat-status" aria-live="polite">
        {busy && (
          <p className="working" role="status">
            <span />
            {activity || "Working"}…
          </p>
        )}
      </div>
      {(error || session?.error) && (
        <div className="error chat-error" role="alert">
          {error || session.error}
          {session?.state === "error" && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => onSend({ retry: true })}
            >
              Continue from saved progress
              <Icon name="arrow" size={16} />
            </button>
          )}
        </div>
      )}
      {session?.state === "running" && !busy && (
        <p className="working">
          Still working.
          <button className="text-button" onClick={() => onSelect(session.id)}>
            Check for reply
          </button>
        </p>
      )}
      <div className="composer-area">
        {context.length > 0 && (
          <div className="attachments" aria-label="Conversation context">
            {context.map((ref) => (
              <span className="attachment" key={ref.id}>
                <Icon
                  name={ref.type === "Document" ? "file" : "home"}
                  size={16}
                />
                <span>{recordName(ref.id)}</span>
                <IconButton
                  name="close"
                  label={`Remove context for ${recordName(ref.id)}`}
                  disabled={busy}
                  onClick={() =>
                    setContext(context.filter((r) => r.id !== ref.id))
                  }
                />
              </span>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments" aria-label="Attached files">
            {attachments.map((doc) => (
              <span className="attachment" key={doc.id}>
                <Icon name="file" size={16} />
                <span>{doc.title}</span>
                <IconButton
                  name="close"
                  label={`Remove ${doc.title} from message`}
                  disabled={busy}
                  onClick={() =>
                    setAttachments(
                      attachments.filter((item) => item.id !== doc.id),
                    )
                  }
                />
              </span>
            ))}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Mark size={28} />
          <label className="sr-only" htmlFor="message">
            Message HomeKeeper
          </label>
          <textarea
            id="message"
            placeholder={
              attachments.length
                ? "Ask about this, or send to organize it"
                : "Ask anything about your home"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={18000}
            disabled={blocked}
            autoFocus
          />
          <div className="composer-actions">
            {SpeechRecognition && (
              <IconButton
                name="mic"
                label={listening ? "Stop dictation" : "Dictate message"}
                className={listening ? "recording" : ""}
                disabled={blocked && !listening}
                onClick={dictate}
              />
            )}
            <label
              className={`icon-button attach-control ${blocked || attachments.length >= 5 ? "disabled" : ""}`}
              title="Attach PDF or text"
            >
              <Icon name="attach" />
              <input
                type="file"
                aria-label="Attach PDF or text"
                accept=".pdf,.txt"
                disabled={blocked || attachments.length >= 5}
                onChange={(e) => {
                  void onUpload(e.target.files[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              className="icon-button send"
              type="submit"
              disabled={blocked || (!draft.trim() && !attachments.length)}
              aria-label="Send message"
            >
              <Icon name="send" />
            </button>
          </div>
        </form>
        <div className="composer-meta">
          <label>
            <input
              type="checkbox"
              checked={execution === "review"}
              disabled={busy}
              onChange={(e) =>
                setExecution(e.target.checked ? "review" : "direct")
              }
            />
            Review before saving
          </label>
          <span>
            {execution === "direct"
              ? "Saves when you ask"
              : "You approve changes"}
          </span>
        </div>
      </div>
      {!hasMessages && !attachments.length && (
        <div className="suggestions" aria-label="Conversation ideas">
          <button
            disabled={blocked}
            onClick={() =>
              onAsk(careRequest, { immediate: true, readOnly: true })
            }
          >
            What needs care?
            <Icon name="arrow" size={14} />
          </button>
          <button
            disabled={blocked}
            onClick={() => setDraft("Something at home needs fixing: ")}
          >
            Something needs fixing
            <Icon name="arrow" size={14} />
          </button>
          <button
            disabled={blocked}
            onClick={() => setDraft("Remember this about my home: ")}
          >
            Remember my home
            <Icon name="arrow" size={14} />
          </button>
        </div>
      )}
      {!status?.model_configured && (
        <p className="connection-note" role="status">
          Configure the AI provider in .env to chat. Saved records remain
          available.
        </p>
      )}
    </main>
  );
}
