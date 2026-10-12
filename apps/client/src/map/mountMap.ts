import Phaser from "phaser";
import { PALETTE } from "./palette";
import { CityScene } from "./CityScene";

export interface MapHandle {
  destroy(): void;
}

export function mountMap(parent: HTMLElement): MapHandle {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: PALETTE.background,
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth, height: parent.clientHeight },
    input: { touch: { capture: true } },
    disableContextMenu: true,
    scene: [CityScene],
  });
  return { destroy: () => game.destroy(true) };
}
