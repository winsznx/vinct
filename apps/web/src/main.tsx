import "./polyfill";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Shell } from "./components/Shell";
import { Adapters } from "./routes/Adapters";
import { Formation } from "./routes/Formation";
import { IncidentRoom } from "./routes/IncidentRoom";
import { NotFound } from "./routes/NotFound";
import { Observer } from "./routes/Observer";
import { Overview } from "./routes/Overview";
import { Proof } from "./routes/Proof";
import { Settlement } from "./routes/Settlement";
import { Status } from "./routes/Status";
import "./styles/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("no root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/formation" element={<Formation />} />
          <Route path="/adapters" element={<Adapters />} />
          <Route path="/incident" element={<IncidentRoom />} />
          <Route path="/observer" element={<Observer />} />
          <Route path="/settlement" element={<Settlement />} />
          <Route path="/proof" element={<Proof />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
