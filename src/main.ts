import "./styles.css";
import { Game, webGLFailure } from "./game/Game";

const root = document.querySelector<HTMLElement>("#game-root");

if (!root) {
  throw new Error("The Neon Grapple Rush root element is missing.");
}

function showStartupFailure(container: HTMLElement, error: unknown): void {
  container.replaceChildren();
  const panel = document.createElement("main");
  panel.className = "compatibility-panel";
  const title = document.createElement("h1");
  title.textContent = "The skyline could not start";
  const message = document.createElement("p");
  message.textContent =
    error instanceof Error
      ? error.message
      : "An unexpected graphics error stopped the game from loading.";
  const retry = document.createElement("button");
  retry.className = "neon-button primary";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => window.location.reload());
  panel.append(title, message, retry);
  container.append(panel);
  console.error("[Neon Grapple Rush] Startup failure", error);
}

if (!webGLFailure(root)) {
  try {
    const game = new Game(root);
    const handlePageHide = (event: PageTransitionEvent): void => {
      // A persisted page is frozen in the back-forward cache and will resume
      // with the same Game instance when the user navigates back.
      if (event.persisted) return;
      window.removeEventListener("pagehide", handlePageHide);
      game.dispose({ preserveMultiplayerSession: true });
    };
    window.addEventListener("pagehide", handlePageHide);
    void game.start().catch((error: unknown) => {
      window.removeEventListener("pagehide", handlePageHide);
      game.dispose();
      showStartupFailure(root, error);
    });
  } catch (error) {
    showStartupFailure(root, error);
  }
}
