import "./styles.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router";
import { checkAuth, initAuth } from "./app/auth";
import { AppRoutes } from "./app/routes";

/** Notification clicks on an open window navigate in place (see sw.ts). */
function ServiceWorkerNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type !== "navigate" || typeof data.url !== "string") return;
      const url = new URL(data.url, location.origin);
      if (url.origin !== location.origin) return;
      navigate(url.pathname + url.search + url.hash);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);
  return null;
}

initAuth();
if (
  !/^\/(sign-in|enroll)/.test(location.pathname) ||
  !/token=/.test(location.hash + location.search)
) {
  void checkAuth();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ServiceWorkerNavigation />
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
