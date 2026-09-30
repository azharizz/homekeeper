import { apiUrl } from "../api";
import { useState } from "react";
import PhotoAlignment from "../PhotoAlignment";
import { Icon } from "../ui";
import { ArchitectureMesh } from "./Scene";

export default function PhotosPanel({ scene, photo, onPhoto, picked, active }) {
  const [aligning, setAligning] = useState(false);
  const [drafts, setDrafts] = useState({});
  const photoIndex = scene.frames.findIndex((frame) => frame.name === photo);
  return (
    <div hidden={!active} className="architecture-source">
      <div className="photo-navigation">
        <button
          className="icon-button"
          aria-label="Previous photo"
          disabled={photoIndex <= 0}
          onClick={() => onPhoto(scene.frames[photoIndex - 1].name)}
        >
          <Icon name="back" />
        </button>
        <select
          aria-label="Source photo"
          value={photo}
          onChange={(e) => onPhoto(e.target.value)}
        >
          {scene.frames.map((frame, i) => (
            <option key={frame.name} value={frame.name}>
              Photo {i + 1} of {scene.frames.length}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="Next photo"
          disabled={photoIndex >= scene.frames.length - 1}
          onClick={() => onPhoto(scene.frames[photoIndex + 1].name)}
        >
          <Icon name="arrow" />
        </button>
      </div>
      <button
        className="text-button alignment-toggle"
        aria-pressed={aligning}
        onClick={() => setAligning(!aligning)}
      >
        {aligning ? "Hide alignment tools" : "Compare photo alignment"}
      </button>
      {active &&
        (aligning ? (
          <PhotoAlignment
            key={`${photo}:${scene.revision}`}
            scene={scene}
            photo={photo}
            picked={picked}
            draft={
              drafts[photo]?.revision === scene.revision ? drafts[photo] : null
            }
            onDraftChange={(draft) =>
              setDrafts((current) => ({
                ...current,
                [photo]: { ...draft, revision: scene.revision },
              }))
            }
            renderModel={() => (
              <ArchitectureMesh
                scene={scene}
                level=""
                cutaway={false}
                selected=""
                onSelect={() => {}}
              />
            )}
          />
        ) : (
          <>
            <a
              href={apiUrl(`/maps/${scene.id}/images/${photo}`)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={apiUrl(`/maps/${scene.id}/images/${photo}`)}
                alt={`Source photo ${photoIndex + 1}, ${scene.frames[photoIndex].original}`}
              />
            </a>
            <p className="hint">
              {scene.frames[photoIndex].original} · Open image for full size.
            </p>
          </>
        ))}
    </div>
  );
}
