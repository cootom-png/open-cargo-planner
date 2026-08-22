import assert from "node:assert/strict";
import test from "node:test";
import { generateOrientations, type ProductType } from "../src/index.js";

const product = (overrides: Partial<ProductType> = {}): ProductType => ({
  id: "product-1",
  sku: "SKU-1",
  name: "测试产品",
  lengthMm: 600,
  widthMm: 400,
  heightMm: 300,
  weightG: 10_000,
  quantity: 10,
  allowHorizontalRotation: true,
  allowSideLoading: false,
  allowUpsideDown: false,
  mustStayUpright: false,
  stackable: true,
  palletPolicy: "auto",
  priority: 1,
  ...overrides,
});

test("禁止侧装时只生成正常姿态和水平旋转", () => {
  assert.deepEqual(generateOrientations(product()).map((item) => item.code), ["LWH", "WLH"]);
});

test("允许侧装但禁止倒置时生成六种正交朝向", () => {
  const result = generateOrientations(product({ allowSideLoading: true }));
  assert.equal(result.length, 6);
  assert.equal(result.some((item) => item.upsideDown), false);
  assert.equal(result.filter((item) => item.sideLoaded).length, 4);
});

test("必须正放覆盖侧装和倒置权限", () => {
  const result = generateOrientations(product({
    mustStayUpright: true,
    allowSideLoading: true,
    allowUpsideDown: true,
  }));
  assert.deepEqual(result.map((item) => item.code), ["LWH", "WLH"]);
});

test("相同尺寸产生的重复几何朝向会被去除", () => {
  const result = generateOrientations(product({
    lengthMm: 500,
    widthMm: 500,
    heightMm: 500,
    allowSideLoading: true,
  }));
  assert.equal(result.length, 1);
});

test("精细朝向白名单限制最终结果", () => {
  const result = generateOrientations(product({
    allowSideLoading: true,
    allowedOrientations: ["LWH", "WHL"],
  }));
  assert.deepEqual(result.map((item) => item.code), ["LWH", "WHL"]);
});
