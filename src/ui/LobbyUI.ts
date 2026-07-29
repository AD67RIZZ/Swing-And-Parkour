export interface LobbyPlayer {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  host?: boolean;
  connected?: boolean;
}

export interface LobbyState {
  roomCode: string;
  players: LobbyPlayer[];
  localPlayerId?: string;
  connected: boolean;
  ping?: number;
  countdown?: number | null;
  capacity?: number;
}

export type LobbyAction = "ready" | "leave" | "copy-room-code";

export interface LobbyUIOptions {
  onAction?: (action: LobbyAction) => void;
}

/** Ready-up lobby renderer that can also be embedded by MenuUI. */
export class LobbyUI {
  public readonly element: HTMLElement;
  private readonly roomButton: HTMLButtonElement;
  private readonly roomCodeValue: HTMLElement;
  private readonly roomCopyHint: HTMLElement;
  private readonly roomCopyStatus: HTMLElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly playerList: HTMLOListElement;
  private readonly countdown: HTMLElement;
  private readonly readyButton: HTMLButtonElement;
  private state: LobbyState;
  private playerSignature = "";

  public constructor(
    parent: HTMLElement,
    private readonly options: LobbyUIOptions = {},
    initialState: LobbyState = {
      roomCode: "----",
      players: [],
      connected: false,
      countdown: null,
      capacity: 8,
    },
  ) {
    this.state = initialState;
    this.element = document.createElement("section");
    this.element.className = "lobby-ui";
    this.element.setAttribute("aria-label", "Match lobby");

    const header = document.createElement("div");
    header.className = "lobby-header";
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "PRIVATE SKYLINE";
    const title = document.createElement("h2");
    title.tabIndex = -1;
    title.textContent = "Match lobby";
    titleWrap.append(eyebrow, title);

    this.roomButton = document.createElement("button");
    this.roomButton.type = "button";
    this.roomButton.className = "room-code";
    const roomLabel = document.createElement("span");
    roomLabel.textContent = "ROOM CODE";
    this.roomCodeValue = document.createElement("strong");
    this.roomCopyHint = document.createElement("small");
    this.roomCopyHint.textContent = "Tap to copy";
    this.roomButton.append(roomLabel, this.roomCodeValue, this.roomCopyHint);
    this.roomButton.addEventListener("click", () => this.options.onAction?.("copy-room-code"));
    header.append(titleWrap, this.roomButton);
    this.element.append(header);
    this.roomCopyStatus = document.createElement("span");
    this.roomCopyStatus.className = "visually-hidden";
    this.roomCopyStatus.setAttribute("role", "status");
    this.element.append(this.roomCopyStatus);

    const status = document.createElement("div");
    status.className = "lobby-status";
    this.statusDot = document.createElement("span");
    this.statusDot.className = "status-dot";
    this.statusDot.setAttribute("aria-hidden", "true");
    this.statusText = document.createElement("span");
    status.append(this.statusDot, this.statusText);
    this.element.append(status);

    this.playerList = document.createElement("ol");
    this.playerList.className = "player-list";
    this.element.append(this.playerList);

    this.countdown = document.createElement("p");
    this.countdown.className = "lobby-countdown";
    this.countdown.setAttribute("aria-live", "polite");
    this.element.append(this.countdown);

    const actions = document.createElement("div");
    actions.className = "menu-actions horizontal";
    const leave = actionButton("Leave lobby", "secondary", () => this.options.onAction?.("leave"));
    this.readyButton = actionButton("Ready up", "primary", () => this.options.onAction?.("ready"));
    actions.append(leave, this.readyButton);
    this.element.append(actions);

    parent.append(this.element);
    this.update(initialState);
  }

  public update(state: LobbyState): void {
    const roomChanged = state.roomCode !== this.state.roomCode;
    this.state = state;
    this.roomCodeValue.textContent = state.roomCode;
    this.roomButton.setAttribute("aria-label", `Copy room code ${state.roomCode}`);
    if (roomChanged) {
      this.roomCopyHint.textContent = "Tap to copy";
      this.roomCopyStatus.textContent = "";
    }

    this.statusDot.classList.toggle("online", state.connected);
    this.statusDot.classList.toggle("offline", !state.connected);
    const nextStatus = state.connected
      ? `Connected${state.ping === undefined ? "" : ` · ${Math.round(state.ping)} ms`}`
      : "Reconnecting…";
    if (this.statusText.textContent !== nextStatus) this.statusText.textContent = nextStatus;

    const capacity = Math.max(state.players.length, Math.min(state.capacity ?? 8, 8));
    this.playerList.setAttribute("aria-label", `${state.players.length} players in lobby`);
    const nextPlayerSignature = JSON.stringify({
      localPlayerId: state.localPlayerId,
      capacity,
      players: state.players.map((player) => [
        player.id,
        player.name,
        player.color,
        player.ready,
        player.host,
        player.connected,
      ]),
    });
    if (nextPlayerSignature !== this.playerSignature) {
      this.playerSignature = nextPlayerSignature;
      this.renderPlayers(capacity);
    }

    const nextCountdown =
      state.countdown !== null && state.countdown !== undefined
        ? `Launch in ${Math.max(0, Math.ceil(state.countdown))}`
        : state.players.length < 2
          ? "Waiting for another runner"
          : "Ready up to begin";
    if (this.countdown.textContent !== nextCountdown) this.countdown.textContent = nextCountdown;

    const local = state.players.find((player) => player.id === state.localPlayerId);
    this.readyButton.textContent = local?.ready ? "Not ready" : "Ready up";
    this.readyButton.disabled = !state.connected || !local || local.connected === false;
  }

  public setCopyStatus(message: string): void {
    this.roomCopyHint.textContent = message;
    this.roomCopyStatus.textContent = message;
  }

  private renderPlayers(capacity: number): void {
    const state = this.state;
    const fragment = document.createDocumentFragment();
    for (const player of state.players) {
      const item = document.createElement("li");
      item.className = `lobby-player ${player.ready ? "is-ready" : ""}`;
      if (player.id === state.localPlayerId) item.classList.add("is-you");
      if (player.connected === false) item.classList.add("is-disconnected");

      const swatch = document.createElement("span");
      swatch.className = "player-swatch";
      swatch.style.setProperty("--player-color", player.color);
      const name = document.createElement("strong");
      name.textContent = player.name;
      const badges = document.createElement("span");
      badges.className = "player-badges";
      if (player.host) {
        const host = document.createElement("em");
        host.textContent = "HOST";
        badges.append(host);
      }
      if (player.id === state.localPlayerId) {
        const you = document.createElement("em");
        you.textContent = "YOU";
        badges.append(you);
      }
      const ready = document.createElement("span");
      ready.className = "ready-state";
      ready.textContent =
        player.connected === false ? "OFFLINE" : player.ready ? "READY ✓" : "TUNING UP";
      item.append(swatch, name, badges, ready);
      fragment.append(item);
    }

    for (let i = state.players.length; i < Math.min(capacity, 8); i += 1) {
      const empty = document.createElement("li");
      empty.className = "lobby-player empty";
      empty.textContent = "Waiting for runner…";
      fragment.append(empty);
    }
    this.playerList.replaceChildren(fragment);
  }

  public focus(): void {
    this.element.querySelector<HTMLElement>("button")?.focus();
  }

  public destroy(): void {
    this.element.remove();
  }
}

function actionButton(
  label: string,
  kind: "primary" | "secondary",
  callback: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `neon-button ${kind}`;
  button.textContent = label;
  button.addEventListener("click", callback);
  return button;
}
