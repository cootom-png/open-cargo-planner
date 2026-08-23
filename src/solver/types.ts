import type { Orientation } from "../domain/model.js";

/** 单个已放置货物的三维包围盒与朝向信息。 */
export interface Placement {
  /** 对应的产品在 PlanInput.products 中的下标。 */
  productIndex: number;
  /** SKU 标识。 */
  sku: string;
  /** 放置朝向。 */
  orientation: Orientation;
  /** 包围盒左下前角坐标（mm）。 */
  x: number;
  y: number;
  z: number;
  /** 装载索引入围的容器编号。 */
  containerIndex: number;
}

/** 未装入的 SKU 明细。 */
export interface UnloadedItem {
  sku: string;
  productIndex: number;
  remaining: number;
}

/** 求解汇总指标。 */
export interface PlanMetrics {
  /** 已装货物总体积（mm³）。 */
  loadedVolumeMm3: number;
  /** 可用容器总体积（mm³）。 */
  containerVolumeMm3: number;
  /** 体积利用率 0~1。 */
  volumeRatio: number;
  /** 已装货物总重（g）。 */
  loadedWeightG: number;
  /** 可用容器总载重（g）。 */
  containerPayloadG: number;
  /** 重量利用率 0~1。 */
  weightRatio: number;
  /** 使用的容器数量。 */
  containersUsed: number;
}

/** 求解器返回的完整方案。 */
export interface PlanResult {
  placements: Placement[];
  unloaded: UnloadedItem[];
  metrics: PlanMetrics;
  /** 警告信息（如达到求解上限、支撑率放宽等）。 */
  warnings: string[];
  /** 约束与参数快照（用于结果可复现）。 */
  solverVersion: string;
}
