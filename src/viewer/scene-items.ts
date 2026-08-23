import type { Placement } from "../solver/types.js";

export interface LegacyPlacement {
  x: number;
  y: number;
  z: number;
  l: number;
  w: number;
  h: number;
  ci: number;
  pi: number;
}

export interface SceneProduct {
  sku: string;
  color: string;
}

export interface SceneItem {
  id: string;
  kind: "cargo" | "pallet";
  sku: string;
  productIndex: number;
  containerIndex: number;
  dimensionsMm: { length: number; width: number; height: number };
  centerMm: { x: number; y: number; z: number };
  originMm: { x: number; y: number; z: number };
  orientation: string;
  color: string;
}

function toSceneItem(
  placement: { x: number; y: number; z: number },
  dimensions: { length: number; width: number; height: number },
  metadata: Omit<SceneItem, "dimensionsMm" | "centerMm" | "originMm">,
): SceneItem {
  return {
    ...metadata,
    dimensionsMm: dimensions,
    originMm: { x: placement.x, y: placement.y, z: placement.z },
    centerMm: {
      x: placement.x + dimensions.length / 2,
      y: placement.y + dimensions.width / 2,
      z: placement.z + dimensions.height / 2,
    },
  };
}

/** 当前单文件原型输出的适配边界；正式求解器接入时无需改 Three.js 渲染层。 */
export function legacyPlacementToSceneItem(
  placement: LegacyPlacement,
  product: SceneProduct,
  index: number,
): SceneItem {
  const rotated = placement.l !== placement.w && placement.l !== 0
    ? `${placement.l}×${placement.w}×${placement.h}`
    : "默认";
  return toSceneItem(
    placement,
    { length: placement.l, width: placement.w, height: placement.h },
    {
      id: `cargo-${placement.ci}-${index}`,
      kind: "cargo",
      sku: product.sku,
      productIndex: placement.pi,
      containerIndex: placement.ci,
      orientation: rotated,
      color: product.color,
    },
  );
}

/** 正式求解器 Placement 的适配边界。 */
export function solverPlacementToSceneItem(
  placement: Placement,
  color: string,
  index: number,
): SceneItem {
  const { lengthMm, widthMm, heightMm, code } = placement.orientation;
  return toSceneItem(
    placement,
    { length: lengthMm, width: widthMm, height: heightMm },
    {
      id: `cargo-${placement.containerIndex}-${index}`,
      kind: "cargo",
      sku: placement.sku,
      productIndex: placement.productIndex,
      containerIndex: placement.containerIndex,
      orientation: code,
      color,
    },
  );
}

export function legacyPalletToSceneItem(
  placement: Omit<LegacyPlacement, "pi">,
  index: number,
): SceneItem {
  return toSceneItem(
    placement,
    { length: placement.l, width: placement.w, height: placement.h },
    {
      id: `pallet-${placement.ci}-${index}`,
      kind: "pallet",
      sku: `托盘 ${index + 1}`,
      productIndex: -1,
      containerIndex: placement.ci,
      orientation: "托盘",
      color: "#b78346",
    },
  );
}
