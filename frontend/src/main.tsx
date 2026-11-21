import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { inWindow, setServer } from "./bridge";
import { start as startLanguage } from "./i18n";
import Login from "./Login";
import "./style.css";

/** In a browser, the server is asked first whether this browser is signed in. */
function Root() {
  const [auth, setAuth] = useState<boolean | null>(inWindow() ? true : null);
  const ask = () =>
    fetch("/api/session")
      .then((r) => r.json())
      .then(
        (s) => {
          setServer(s);
          setAuth(!!s.auth);
        },
        () => setAuth(true), // no such address: a server from before sign-in existed
      );
  useEffect(() => {
    if (auth === null) ask();
    // A session that ended while the page was open: back to the sign-in.
    const lost = () => setAuth(false);
    window.addEventListener("boxforge-signed-out", lost);
    return () => window.removeEventListener("boxforge-signed-out", lost);
  }, []);
  if (auth === null) return null;
  return auth ? <App /> : <Login onDone={ask} />;
}

startLanguage();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
