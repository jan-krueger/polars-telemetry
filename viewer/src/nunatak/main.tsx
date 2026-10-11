import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "../styles.css";
import "./nunatak.css";
import App from "./App";
import Boundary from "../components/Boundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode><Boundary><App /></Boundary></StrictMode>
);
