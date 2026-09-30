import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./roomtrace/roomtrace.css";
import { App } from "./App.jsx";
import { api } from "./components.jsx";

const results = await Promise.allSettled([
  api("/api/home"),
  api("/api/status"),
  api("/api/conversations"),
]);
if (results[2].value?.length)
  results.push(
    ...(await Promise.allSettled([
      api(`/api/conversations/${results[2].value[0].id}`),
    ])),
  );
createRoot(document.getElementById("root")).render(<App initial={results} />);
