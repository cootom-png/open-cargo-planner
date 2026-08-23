import assert from "node:assert/strict";
import test from "node:test";
import type { Placement } from "../src/solver/types.js";
import { legacyPlacementToSceneItem, solverPlacementToSceneItem } from "../src/viewer/scene-items.js";

test("把原型 placement 转为实际尺寸和中心坐标", () => {
  const item = legacyPlacementToSceneItem(
    { x: 100, y: 200, z: 300, l: 520, w: 380, h: 310, ci: 2, pi: 1 },
    { sku: "BX-1001", color: "#3478d4" },
    7,
  );

  assert.deepEqual(item.dimensionsMm, { length: 520, width: 380, height: 310 });
  assert.deepEqual(item.centerMm, { x: 360, y: 390, z: 455 });
  assert.deepEqual(item.originMm, { x: 100, y: 200, z: 300 });
  assert.equal(item.containerIndex, 2);
  assert.equal(item.productIndex, 1);
  assert.equal(item.sku, "BX-1001");
});

test("把正式求解器 Placement 朝向尺寸转为 scene item", () => {
  const placement: Placement = {
    productIndex: 0,
    sku: "CH-2040",
    x: 10,
    y: 20,
    z: 30,
    containerIndex: 1,
    orientation: {
      code: "WLH",
      lengthMm: 480,
      widthMm: 920,
      heightMm: 180,
      sideLoaded: false,
      upsideDown: false,
    },
  };

  const item = solverPlacementToSceneItem(placement, "#19a17a", 3);
  assert.deepEqual(item.dimensionsMm, { length: 480, width: 920, height: 180 });
  assert.deepEqual(item.centerMm, { x: 250, y: 480, z: 120 });
  assert.equal(item.orientation, "WLH");
  assert.equal(item.containerIndex, 1);
});
