/**
 * Renderer entry point.
 *
 * The global error boundary and the providers live in `App`; this file only
 * mounts it and fails loudly if the root element is missing, which would
 * otherwise render a blank window with no explanation.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("Root element #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);