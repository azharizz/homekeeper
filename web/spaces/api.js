export const apiUrl = (path) => `/roomtrace/api${path}`;

export async function request(path, options) {
  const response = await fetch(apiUrl(path), options);
  const value = await response.json();
  if (!response.ok) {
    const message =
      typeof value.detail === "string"
        ? value.detail
        : "Check the submitted values.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return value;
}

export const post = (path, body) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const artifact = (id, name) => apiUrl(`/maps/${id}/artifacts/${name}`);
