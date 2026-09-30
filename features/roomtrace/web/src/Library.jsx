import { useState } from "react";
import { Icon, PageList } from "./ui";

export default function Library({ maps, selected, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = maps.filter(
    (item) =>
      item.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "ready"
          ? item.status === "ready"
          : item.status !== "ready")),
  );
  return (
    <aside className="library-panel" aria-label="Your spaces">
      <div className="panel-heading">
        <h2>Your spaces</h2>
        <button
          className="icon-button"
          aria-label="Close library"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <label className="search-field">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search spaces"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search spaces"
        />
      </label>
      <div className="segmented" role="group" aria-label="Filter spaces">
        {[
          ["all", "All"],
          ["ready", "Ready"],
          ["other", "In progress / failed"],
        ].map(([value, label]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <PageList
        key={`${search}:${filter}`}
        items={filtered}
        label="Spaces"
        empty={
          maps.length
            ? "No spaces match your search."
            : "Add your first photos to create a space."
        }
      >
        {(page) => (
          <nav aria-label="Saved spaces" className="space-list">
            {page.map((item) => (
              <button
                key={item.id}
                className={`space-entry ${selected === item.id ? "selected" : ""}`}
                aria-current={selected === item.id ? "page" : undefined}
                onClick={() => onSelect(item.id)}
              >
                <Icon name="cube" />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.status === "ready"
                      ? `${item.summary.total_frames || item.summary.registered_frames || 0} views · ${item.summary.mode === "architecture" ? "Structured model" : "Photo mesh"}`
                      : item.status === "awaiting_agent"
                        ? "Needs Codex"
                        : item.status}
                  </small>
                </span>
                <Icon name="arrow" size={16} />
              </button>
            ))}
          </nav>
        )}
      </PageList>
    </aside>
  );
}
