import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";

import type { PetSize } from "./settings";

export interface LogicalRect {
  width: number;
  height: number;
}

interface PhysicalPoint {
  x: number;
  y: number;
}

interface WorkArea extends PhysicalPoint, LogicalRect {}

export const PET_SIZES: Record<PetSize, LogicalRect> = {
  small: { width: 300, height: 420 },
  standard: { width: 400, height: 560 },
  large: { width: 500, height: 700 },
};

const WINDOW_MARGIN = 12;
const ANCHOR_DISTANCE = 48;

export function clampPosition(
  position: PhysicalPoint,
  windowSize: LogicalRect,
  workArea: WorkArea,
  margin: number,
): PhysicalPoint {
  const minX = workArea.x + margin;
  const minY = workArea.y + margin;
  const maxX = Math.max(
    minX,
    workArea.x + workArea.width - windowSize.width - margin,
  );
  const maxY = Math.max(
    minY,
    workArea.y + workArea.height - windowSize.height - margin,
  );
  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY),
  };
}

export function preserveBottomRight(
  oldPosition: PhysicalPoint,
  oldSize: LogicalRect,
  newSize: LogicalRect,
  workArea: WorkArea,
  margin: number,
): PhysicalPoint {
  const rightGap =
    workArea.x + workArea.width - (oldPosition.x + oldSize.width);
  const bottomGap =
    workArea.y + workArea.height - (oldPosition.y + oldSize.height);
  const anchored =
    rightGap >= 0 &&
    rightGap <= ANCHOR_DISTANCE &&
    bottomGap >= 0 &&
    bottomGap <= ANCHOR_DISTANCE;
  const nextPosition = anchored
    ? {
        x: workArea.x + workArea.width - newSize.width - rightGap,
        y: workArea.y + workArea.height - newSize.height - bottomGap,
      }
    : oldPosition;
  return clampPosition(nextPosition, newSize, workArea, margin);
}

export async function resizePetWindow(size: PetSize): Promise<void> {
  const appWindow = getCurrentWindow();
  const [oldPosition, oldSize, monitor] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
    currentMonitor(),
  ]);
  const logicalSize = PET_SIZES[size];
  await appWindow.setSize(new LogicalSize(logicalSize.width, logicalSize.height));
  if (!monitor) return;
  const newSize = await appWindow.outerSize();
  const next = preserveBottomRight(
    oldPosition,
    oldSize,
    newSize,
    monitorWorkArea(monitor),
    WINDOW_MARGIN,
  );
  await appWindow.setPosition(new PhysicalPosition(next.x, next.y));
}

export async function resetPetPosition(): Promise<void> {
  const monitor = await primaryMonitor();
  if (!monitor) return;
  const appWindow = getCurrentWindow();
  const size = await appWindow.outerSize();
  const workArea = monitorWorkArea(monitor);
  const next = clampPosition(
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
    size,
    workArea,
    WINDOW_MARGIN,
  );
  await appWindow.setPosition(new PhysicalPosition(next.x, next.y));
}

function monitorWorkArea(monitor: Monitor): WorkArea {
  return {
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  };
}
