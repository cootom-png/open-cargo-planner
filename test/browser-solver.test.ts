import assert from "node:assert/strict";
import test from "node:test";
import { solveForBrowser } from "../src/browser-solver.js";

test("浏览器入口尊重允许侧装，能使用侧装姿态补齐截图案例", () => {
  const result = solveForBrowser({
    mode: "loose",
    products: [
      {
        name: "A款收纳箱",
        sku: "BX-1001",
        l: 320,
        w: 900,
        h: 310,
        q: 600,
        kg: 8.5,
        rotate: false,
        side: true,
        color: "#3478d4",
      },
    ],
    container: {
      id: "40hq",
      code: "40HQ",
      l: 12032,
      w: 2352,
      h: 2698,
      kg: 26500,
      quantity: 1,
    },
  });

  assert.equal(result.loadedByProduct[0], 600);
  assert.equal(result.sceneItems.length, 600);
  assert.equal(result.sceneItems.some((item) => item.orientation === "WHL"), true);
});
