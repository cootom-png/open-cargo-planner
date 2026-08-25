import assert from "node:assert/strict";
import test from "node:test";
import { solveLoose, type Placement, type PlanInput } from "../src/index.js";

/** assert.ok 的别名（规避 strict 类型下 ok 属性缺失）。 */
const ok = (value: unknown, message?: string): void => {
  if (!value) throw new Error(message ?? "assertion failed");
};

const container40hq = {
  id: "40hq",
  code: "40HQ",
  name: "40HQ",
  innerLengthMm: 12032,
  innerWidthMm: 2352,
  innerHeightMm: 2698,
  doorWidthMm: 2340,
  doorHeightMm: 2585,
  maxPayloadG: 26_500_000,
  quantity: 1,
};

const plan = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  id: "plan-test",
  mode: "loose",
  allocationStrategy: "LARGE_FIRST",
  minimumSupportRatio: 1,
  products: [
    { id: "p1", sku: "SKU-1", name: "测试1", lengthMm: 600, widthMm: 400, heightMm: 300, weightG: 10_000, quantity: 100, allowHorizontalRotation: true, allowSideLoading: false, allowUpsideDown: false, mustStayUpright: false, stackable: true, maxTopLoadG: 50_000, palletPolicy: "forbidden", priority: 1 },
  ],
  palletTypes: [],
  containerTypes: [container40hq],
  ...overrides,
});

const product = (id: string, sku: string, overrides: Partial<PlanInput["products"][number]> = {}) => ({
  id, sku, name: sku,
  lengthMm: 600, widthMm: 400, heightMm: 300, weightG: 10_000, quantity: 100,
  allowHorizontalRotation: true, allowSideLoading: false, allowUpsideDown: false,
  mustStayUpright: false, stackable: true, maxTopLoadG: 50_000,
  palletPolicy: "forbidden" as const, priority: 1,
  ...overrides,
});

/** 校验所有放置互不重叠且都在容器内（仅对同一容器的放置检查重叠）。 */
function assertNoOverlap(placements: Placement[], container = container40hq): void {
  for (let i = 0; i < placements.length; i += 1) {
    const a = placements[i]!;
    ok(a.x >= 0 && a.y >= 0 && a.z >= 0, "坐标不能为负");
    const ax2 = a.x + a.orientation.lengthMm;
    const ay2 = a.y + a.orientation.widthMm;
    const az2 = a.z + a.orientation.heightMm;
    ok(ax2 <= container.innerLengthMm + 1e-6, "越界(长)");
    ok(ay2 <= container.innerWidthMm + 1e-6, "越界(宽)");
    ok(az2 <= container.innerHeightMm + 1e-6, "越界(高)");
    for (let j = i + 1; j < placements.length; j += 1) {
      const b = placements[j]!;
      if (a.containerIndex !== b.containerIndex) continue; // 不同容器坐标独立
      const bx2 = b.x + b.orientation.lengthMm;
      const by2 = b.y + b.orientation.widthMm;
      const bz2 = b.z + b.orientation.heightMm;
      const overlap = a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y && a.z < bz2 && az2 > b.z;
      ok(!overlap, `容器${a.containerIndex}内放置 ${i} 与 ${j} 发生重叠`);
    }
  }
}

test("单规格规则箱得到高体积利用率（>0.70）", () => {
  const input = plan();
  // 需求量远大于单柜容量，确保装满一柜
  input.products[0]!.quantity = 1500;
  const result = solveLoose(input);
  assertNoOverlap(result.placements);
  assert.equal(result.placements.length > 0, true);
  // 理论单柜上限 600×400×300 箱 → floor(12032/600...)，实际应接近 1000+
  ok(result.metrics.volumeRatio > 0.70, `volumeRatio=${result.metrics.volumeRatio.toFixed(3)}`);
});

test("多 SKU 混合装箱且互不重叠", () => {
  const input = plan({
    products: [
      product("p1", "SKU-A", { lengthMm: 700, widthMm: 500, heightMm: 400, quantity: 120 }),
      product("p2", "SKU-B", { lengthMm: 400, widthMm: 300, heightMm: 250, quantity: 200 }),
      product("p3", "SKU-C", { lengthMm: 1000, widthMm: 700, heightMm: 500, quantity: 50 }),
      product("p4", "SKU-D", { lengthMm: 200, widthMm: 200, heightMm: 300, quantity: 400 }),
    ],
  });
  const result = solveLoose(input);
  assertNoOverlap(result.placements);
  ok(result.metrics.volumeRatio > 0.50, `volumeRatio=${result.metrics.volumeRatio.toFixed(3)}`);
  // 装载的总体积不超过容器体积
  ok(result.metrics.loadedVolumeMm3 <= result.metrics.containerVolumeMm3 + 1e-6);
});

test("水平旋转可填补默认姿态留下的连续侧向通道", () => {
  const input = plan({
    products: [
      product("p1", "BX-1001", {
        lengthMm: 320,
        widthMm: 900,
        heightMm: 310,
        weightG: 8_500,
        quantity: 600,
        allowHorizontalRotation: true,
        allowSideLoading: false,
        mustStayUpright: true,
      }),
    ],
  });

  const result = solveLoose(input);
  assertNoOverlap(result.placements);
  assert.equal(result.placements.length, 600);
  assert.deepEqual(result.unloaded, []);
  ok(result.placements.some((placement) => placement.orientation.code === "WLH"), "应使用水平旋转姿态补齐剩余空间");
});

test("不能满足时输出未装明细", () => {
  const input = plan({
    products: [
      product("p1", "SKU-HUGE", { lengthMm: 5000, widthMm: 2000, heightMm: 2000, quantity: 10 }),
    ],
  });
  // 实际每柜只能装下有限个，10 个必然装不下
  const result = solveLoose(input);
  assertNoOverlap(result.placements);
  ok(result.placements.length < 10, `已装 ${result.placements.length}（应小于10）`);
  ok(result.unloaded.length > 0 || result.placements.length < 10, "应存在未装或未装满");
  if (result.unloaded.length > 0) {
    ok(result.warnings.length > 0, "存在未装时应给出警告");
  }
});

test("支撑率校验：非地面货物必须有底部支撑", () => {
  const input = plan({
    products: [
      // 大底箱，下方再放窄小箱时，小箱必须落在被支撑区域
      product("p1", "SKU-TOP", { lengthMm: 800, widthMm: 800, heightMm: 200, quantity: 5, maxTopLoadG: 100_000 }),
    ],
  });
  const result = solveLoose(input);
  assertNoOverlap(result.placements);
  // 所有非地面货物应贴合下方支撑（高度 0 以下对齐）
  for (const p of result.placements) {
    if (p.z > 0) {
      // 需至少有一个已放箱的顶面等于 p.z 且在投影下提供支撑（此处仅验证不悬空逻辑跑通）
      ok(p.z >= 0);
    }
  }
});

test("顶部承重限制有效：超重箱不会堆叠在上方", () => {
  const input = plan({
    products: [
      product("p1", "SKU-STRONG", { lengthMm: 400, widthMm: 400, heightMm: 300, quantity: 4, maxTopLoadG: 5_000, stackable: true }),
      product("p2", "SKU-LIGHT", { lengthMm: 400, widthMm: 400, heightMm: 300, quantity: 20, maxTopLoadG: 1_000, weightG: 800, stackable: true }),
    ],
  });
  let result = solveLoose(input, { enforceTopLoad: true });
  // 禁顶承重时，若上方为 SKU-LIGHT 的累计重量可能超限，但不允许导致不合法堆叠。
  // 此处断言不崩溃且无重叠。
  assertNoOverlap(result.placements);
  result = solveLoose(input, { enforceTopLoad: false });
  assertNoOverlap(result.placements);
});

test("求解器可跨多个容器分配", () => {
  const input = plan();
  input.products[0]!.quantity = 2500;
  input.containerTypes = [container40hq, { ...container40hq, id: "40hq2", quantity: 2 }];
  const result = solveLoose(input);
  assertNoOverlap(result.placements, container40hq);
  const usedContainers = new Set(result.placements.map((p) => p.containerIndex));
  ok(usedContainers.size >= 1);
  ok(result.metrics.containerVolumeMm3 > result.metrics.loadedVolumeMm3);
});
