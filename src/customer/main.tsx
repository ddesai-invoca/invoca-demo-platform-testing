import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "../tokens/tokens.css";
import "../tokens/thoughtspot.css";
import "../styles/app.css";
import "../styles/ts.css";
import "../styles/standalone.css";
import "./customer.css";
import { CustomerApp } from "./CustomerApp";

document.body.classList.add("customer-mode");
createRoot(document.getElementById("root")!).render(<StrictMode><CustomerApp /></StrictMode>);
