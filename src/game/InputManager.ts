export interface InputSnapshot {
  steer: number;
  forward: number;
  grapple: boolean;
  jump: boolean;
  dash: boolean;
  respawn: boolean;
  pause: boolean;
  leaderboard: boolean;
}

interface MobileInputSource {
  state?: {
    steer?: number;
    grapple?: boolean;
    jump?: boolean;
    dash?: boolean;
    pause?: boolean;
  };
  consumeJump?(): boolean;
  consumeDash?(): boolean;
  consumePause?(): boolean;
  consumeOneShots?(): { jump: boolean; dash: boolean; pause: boolean };
}

export function steeringFromControls(
  pressedCodes: ReadonlySet<string>,
  mobileSteer = 0,
): number {
  const screenLeft = pressedCodes.has("KeyA") || pressedCodes.has("ArrowLeft");
  const screenRight = pressedCodes.has("KeyD") || pressedCodes.has("ArrowRight");
  return Math.max(
    -1,
    Math.min(1, Number(screenLeft) - Number(screenRight) - mobileSteer),
  );
}

export class InputManager {
  private readonly down = new Set<string>();
  private enabled = false;
  private jumpQueued = false;
  private dashQueued = false;
  private respawnQueued = false;
  private pauseQueued = false;
  private mouseGrapple = false;
  private mobile?: MobileInputSource;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown, { passive: false });
    window.addEventListener("pointerup", this.onPointerUp, { passive: false });
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("blur", this.reset);
    window.addEventListener("pagehide", this.reset);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    canvas.addEventListener("contextmenu", this.preventContextMenu);
  }

  setMobileSource(source: MobileInputSource | undefined): void {
    this.mobile = source;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.reset();
  }

  snapshot(): InputSnapshot {
    const mobileOneShots = this.mobile?.consumeOneShots?.();
    if (!this.enabled) {
      return {
        steer: 0,
        forward: 0,
        grapple: false,
        jump: false,
        dash: false,
        respawn: false,
        pause: false,
        leaderboard: false,
      };
    }

    // The camera looks toward +Z, so world +X appears on the left of the screen.
    // Letter keys, arrow keys, and touch steering use natural screen directions.
    const forward = this.has("KeyW", "ArrowUp");
    const back = this.has("KeyS", "ArrowDown");
    const mobileState = this.mobile?.state;

    const snapshot: InputSnapshot = {
      steer: steeringFromControls(this.down, mobileState?.steer ?? 0),
      forward: Number(forward) - Number(back),
      grapple: this.mouseGrapple || Boolean(mobileState?.grapple),
      jump:
        this.jumpQueued ||
        Boolean(mobileOneShots?.jump) ||
        Boolean(this.mobile?.consumeJump?.()) ||
        Boolean(mobileState?.jump),
      dash:
        this.dashQueued ||
        Boolean(mobileOneShots?.dash) ||
        Boolean(this.mobile?.consumeDash?.()) ||
        Boolean(mobileState?.dash),
      respawn: this.respawnQueued,
      pause:
        this.pauseQueued ||
        Boolean(mobileOneShots?.pause) ||
        Boolean(this.mobile?.consumePause?.()) ||
        Boolean(mobileState?.pause),
      leaderboard: this.down.has("Tab"),
    };

    this.jumpQueued = false;
    this.dashQueued = false;
    this.respawnQueued = false;
    this.pauseQueued = false;
    return snapshot;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.reset);
    window.removeEventListener("pagehide", this.reset);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.canvas.removeEventListener("contextmenu", this.preventContextMenu);
    this.reset();
  }

  private has(...codes: string[]): boolean {
    return codes.some((code) => this.down.has(code));
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.defaultPrevented || isUiTarget(event.target)) return;
    const firstPress = !this.down.has(event.code);
    this.down.add(event.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      event.preventDefault();
    }
    if (!firstPress) return;
    if (event.code === "Space") this.jumpQueued = true;
    if (event.code === "KeyE") this.dashQueued = true;
    if (event.code === "KeyR") this.respawnQueued = true;
    if (event.code === "Escape" || event.code === "KeyP") this.pauseQueued = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
    if (
      this.enabled &&
      !isUiTarget(event.target) &&
      ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)
    ) {
      event.preventDefault();
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (event.button === 2) {
      this.mouseGrapple = true;
      event.preventDefault();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 2) this.mouseGrapple = false;
  };

  private readonly onPointerCancel = (): void => {
    this.mouseGrapple = false;
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.reset();
  };

  private readonly reset = (): void => {
    this.down.clear();
    this.jumpQueued = false;
    this.dashQueued = false;
    this.respawnQueued = false;
    this.pauseQueued = false;
    this.mouseGrapple = false;
  };

  private readonly preventContextMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
}

function isUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".ui-root"));
}
