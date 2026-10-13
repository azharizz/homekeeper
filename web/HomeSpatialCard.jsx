import React, { useState } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { Icon } from "./components.jsx";
import { apiUrl, request } from "./spaces/api.js";

const previewClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
  },
});

export default function HomeSpatialCard({
  record,
  revision,
  kind = "object",
  title,
  description,
  storedItem,
  actionLabel,
  onShowSpace,
}) {
  const { space_id: spaceId, element_id: elementId } = record;
  const identity = `${spaceId}:${elementId}:${revision}`;
  const [failedPhoto, setFailedPhoto] = useState(null);
  const preview = useQuery({
    queryKey: ["home-spatial-preview", spaceId, elementId, revision],
    enabled: revision != null,
    queryFn: async ({ signal }) => {
      const current = await request(`/maps/${encodeURIComponent(spaceId)}/architecture`, { signal });
      if (current.revision !== revision)
        return { status: "Model changed · photo hidden" };
      const element = current.document?.elements?.find((item) => item.id === elementId);
      const photo = element?.sources?.[0];
      return {
        status: !element
          ? "Object no longer in model"
          : photo
            ? "Source photo"
            : "No source photo",
        url: photo ? apiUrl(`/maps/${encodeURIComponent(spaceId)}/images/${encodeURIComponent(photo)}`) : null,
      };
    },
  }, previewClient);
  const current = failedPhoto?.identity === identity && failedPhoto.checkedAt === preview.dataUpdatedAt
    ? { status: "Photo unavailable · saved link" }
    : preview.isError
      ? { status: "Model unavailable · saved link" }
      : preview.data;
  const status = current?.status || (revision == null ? "Saved link · revision unknown" : "Checking source photo…");
  const storage = kind === "storage";
  return (
    <article className={`home-spatial-card${kind === "care" ? " home-spatial-card--compact" : ""}`}>
      <div className="home-spatial-preview">
        {current?.url ? (
          <img
            src={current.url}
            alt={`Capture photo supporting ${record.element_label || "the saved model object"}; not a 3D render`}
            loading="lazy"
            onError={() => setFailedPhoto({ identity, checkedAt: preview.dataUpdatedAt })}
          />
        ) : (
          <Icon name={storage ? "book" : "cube"} size={25} />
        )}
      </div>
      <div className="home-spatial-copy">
        <span className="home-spatial-badge">{storage ? "Storage link · model estimate" : "Model estimate"}</span>
        {storedItem && (
          <div className="home-spatial-item">
            <small>Stored item</small>
            <strong>{storedItem}</strong>
          </div>
        )}
        <strong className="home-spatial-object">
          {storage && <small>Model container · </small>}
          {record.element_label || "Saved object"}
        </strong>
        <small className="home-spatial-room">{record.space_name || "Saved space"}</small>
        <button
          className="primary home-spatial-action"
          aria-label={actionLabel}
          onClick={() => onShowSpace(spaceId, elementId)}
        >
          <Icon name="cube" size={16} /> View in 3D
        </button>
        {status && <small className="home-spatial-status">{status}</small>}
        {storage && description && (
          <p className="home-spatial-location">{description}</p>
        )}
        {storage ? (
          title && (
            <details className="home-spatial-note">
              <summary>Memory title</summary>
              <h3>{title}</h3>
            </details>
          )
        ) : (
          (title || description) && (
            <details className="home-spatial-note">
              <summary>Saved note</summary>
              {title && <h3>{title}</h3>}
              {description && <p>{description}</p>}
            </details>
          )
        )}
      </div>
    </article>
  );
}
