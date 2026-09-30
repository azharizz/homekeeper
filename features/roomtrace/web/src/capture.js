export const fileKey = (file) =>
  JSON.stringify([file.name, file.size, file.lastModified]);

export function mergeFiles(current, incoming) {
  return [
    ...new Map(
      [...current, ...incoming].map((file) => [fileKey(file), file]),
    ).values(),
  ];
}

export function captureProblem(files, health) {
  if (!files.length) return "";
  const videoCount = files.filter((file) =>
    /\.(mp4|mov|webm|avi|m4v)$/i.test(file.name),
  ).length;
  if (videoCount && (videoCount !== 1 || files.length !== 1))
    return "Choose one video, or a set of photos.";
  if (
    !videoCount &&
    files.some((file) => !/\.(jpe?g|png|webp)$/i.test(file.name))
  )
    return "Use JPEG, PNG or WebP photos, or MP4, MOV, WebM, AVI or M4V video.";
  if (
    !videoCount &&
    (files.length < 4 || files.length > (health?.max_images ?? 12))
  )
    return `Choose 4 to ${health?.max_images ?? 12} overlapping photos.`;
  if (
    files.reduce((sum, file) => sum + file.size, 0) >
    (health?.max_upload_mb ?? 512) * 1024 * 1024
  )
    return "This capture exceeds the upload limit. Choose smaller files.";
  return "";
}
