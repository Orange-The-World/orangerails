import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "./styles.css";

const router = getRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found — check index.html");
}

createRoot(container).render(<RouterProvider router={router} />);

// Fade out the inline loading splash after React paints. Keeps the brand
// moment visible briefly even on fast connections so the framing
// ("encrypting in browser") registers.
const splash = document.getElementById("or-splash");
if (splash) {
  // requestAnimationFrame waits until after the first React paint.
  requestAnimationFrame(() => {
    setTimeout(() => {
      splash.classList.add("or-splash-leaving");
      splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    }, 250); // small minimum visibility window
  });
}
