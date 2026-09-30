import { request } from "node:http";
import { request as secureRequest } from "node:https";

// Stream uploads and GLBs without buffering them in the conversation host.
export function roomtraceProxy({ roomtraceUrl, token }) {
  const base = new URL(roomtraceUrl);
  const send = base.protocol === "https:" ? secureRequest : request;
  return (req, res) => {
    res.set({
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    });
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
      else if (req.path === "/" && req.accepts("html")) {
        res
          .status(503)
          .type("html")
          .send(
            `<!doctype html><html lang="en"><meta charset="utf-8"><title>RoomTrace unavailable</title><style>body{margin:40px;background:#141d22;color:white;font:16px system-ui}p{color:#c7c8ca}a{color:#70d5ff}</style><h1>RoomTrace is unavailable</h1><p>Start the RoomTrace service, then try again.</p><a href="/roomtrace/">Try again</a></html>`,
          );
      } else
        res.status(503).json({
          detail:
            "RoomTrace is unavailable. Start the RoomTrace service and try again.",
        });
    });
    res.on("close", () => upstream.destroy());
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  };
}
