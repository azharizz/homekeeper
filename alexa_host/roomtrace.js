import { request } from "node:http";
import { request as secureRequest } from "node:https";

// Stream uploads and GLBs without buffering them in the conversation host.
export function roomtraceProxy({ roomtraceUrl, token }) {
  const base = new URL(roomtraceUrl);
  const send = base.protocol === "https:" ? secureRequest : request;
  return (req, res) => {
    const headers = {
      host: req.headers.host,
      authorization: `Bearer ${token}`,
    };
    for (const name of [
      "content-type",
      "content-length",
      "origin",
      "range",
      "if-none-match",
    ])
      if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = send(
      `${base.origin}${req.url}`,
      { method: req.method, headers },
      (response) => {
        res.status(response.statusCode);
        for (const name of [
          "content-type",
          "content-length",
          "content-disposition",
          "cache-control",
          "etag",
          "content-range",
          "accept-ranges",
          "permissions-policy",
        ])
          if (response.headers[name]) res.set(name, response.headers[name]);
        if (response.headers.location) {
          const location = new URL(response.headers.location, base);
          res.set(
            "Location",
            `/roomtrace${location.pathname}${location.search}`,
          );
        }
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else
        res.status(503).json({
          detail:
            "Spaces is unavailable. Start the geometry service and try again.",
        });
    });
    res.on("close", () => upstream.destroy());
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  };
}
