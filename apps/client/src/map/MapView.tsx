import { useEffect, useRef } from "react";
import type { MapHandle } from "./mountMap";

/** React ↔ Phaser bridge: React owns the element, Phaser owns everything drawn inside it. */
export function MapView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let handle: MapHandle | undefined;
    let cancelled = false;
    // Phaser is loaded on demand, in its own chunk, so the login screen doesn't wait for it.
    void import("./mountMap").then(({ mountMap }) => {
      if (!cancelled) handle = mountMap(ref.current!);
    });
    // StrictMode mounts twice in development; the cleanup destroys the first game, so only one survives.
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, []);

  return <div className="map" ref={ref} data-testid="map" />;
}
