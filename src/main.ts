import "./styles.css";

import { App } from "./app";

window.addEventListener("DOMContentLoaded", () => {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("CodexPet root element is missing");
  void new App().mount(root);
});
