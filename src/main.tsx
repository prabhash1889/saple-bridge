import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorHandlers } from "./lib/errorReporting";
import "./styles/index.css";

// Forward renderer errors into the Rust-side durable log (Phase 4). Must run before the first
// render so even bootstrap-time crashes are captured. Failure-silent by design.
installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
