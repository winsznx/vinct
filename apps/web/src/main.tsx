import "./polyfill";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { SiteChrome } from "./components/SiteChrome";
import { WalletProvider } from "./lib/wallet";
import { Demo } from "./routes/Demo";
import { Landing } from "./routes/Landing";
import { NotFound } from "./routes/NotFound";
import { Proof } from "./routes/Proof";
import { Status } from "./routes/Status";
import { Adapters } from "./routes/app/Adapters";
import { Covenants, CovenantWorkspace } from "./routes/app/Covenants";
import { CreateCovenant } from "./routes/app/CreateCovenant";
import { AppHome } from "./routes/app/Home";
import { IncidentRoom } from "./routes/app/Incident";
import { Incidents } from "./routes/app/Incidents";
import "./styles/tokens.css";

/**
 * Two frames, deliberately.
 *
 * Public routes get the marketing chrome. Application routes get the console shell, which each
 * one mounts itself so a route can control its own header. The old build had one nav for both,
 * which is how a product ends up with navigation named after its own internals.
 */
function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <SiteChrome>
            <Landing />
          </SiteChrome>
        }
      />
      <Route
        path="/demo"
        element={
          <SiteChrome>
            <Demo />
          </SiteChrome>
        }
      />
      <Route path="/proof" element={<Proof />} />
      <Route path="/proof/:operationId" element={<Proof />} />
      <Route path="/status" element={<Status />} />

      <Route path="/app" element={<AppHome />} />
      <Route path="/app/covenants" element={<Covenants />} />
      <Route path="/app/covenants/new" element={<CreateCovenant />} />
      <Route path="/app/covenants/:covenantId" element={<CovenantWorkspace />} />
      <Route path="/app/covenants/:covenantId/incidents/:incidentId" element={<IncidentRoom />} />
      <Route path="/app/incidents" element={<Incidents />} />
      <Route path="/app/adapters" element={<Adapters />} />
      <Route path="/app/proof" element={<ProofRedirect />} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/** Proof is one product, reachable from both frames. The app nav points at the public one. */
function ProofRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/proof", search: location.search }} replace />;
}

const root = document.getElementById("root");
if (!root) throw new Error("no root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
