import App from "./App";
import { createRoot } from "react-dom/client";
import { initI18n } from "./utils/i18nUtils";
import { ErrorBoundary } from "./components/ErrorBoundary";

console.log("[LTV Frontend] === Starting application initialization ===");

import { Suspense } from 'react';

// Ensure that locales are loaded before rendering the app
initI18n().then(() => {
  console.log("[LTV Frontend] initI18n completed successfully. Rendering app...");
  const root = createRoot(document.getElementById("app"));
  root.render(
    <ErrorBoundary>
      <Suspense fallback={<div>Loading App...</div>}>
        <App />
      </Suspense>
    </ErrorBoundary>
  );
  console.log("[LTV Frontend] React render method called.");
}).catch((err) => {
  console.error("[LTV Frontend CRITICAL] Failed to initialize i18n:", err);
  document.getElementById("app").innerHTML = "<h2>Failed to load app locales. Check console.</h2>";
});
