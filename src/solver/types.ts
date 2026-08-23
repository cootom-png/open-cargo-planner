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

/** 托盘上单个已码放箱体的记录。 */
export interface PalletItemPlacement {
  productIndex: number;
  sku: string;
  /** 托盘内坐标（mm），坐标原点为托盘左下前角（不含托盘自身高度）。 */
  x: number;
  y: number;
  z: number;
  /** 箱体尺寸与朝向（length/width/height 为该箱在托盘内的实际朝向）。 */
  orientation: Orientation;
  /** 所在层号（从 0 开始，不含托盘本体）。 */
  layerIndex: number;
}

/** 单个完整托盘载荷（LoadUnit），作为装柜阶段不可拆分的整体。 */
export interface PalletLoadUnit {
  /** 使用的托盘类型下标。 */
  palletTypeIndex: number;
  /** 托盘类型 id。 */
  palletTypeId: string;
  /** 托盘型号代码。 */
  palletCode: string;
  /** 托盘既有尺寸（长×宽×高，mm）。 */
  palletLengthMm: number;
  palletWidthMm: number;
  palletHeightMm: number;
  /** 该托的 SKU 明细（逐 SKU 数量）。 */
  skuSummary: Array<{ sku: string; productIndex: number; quantity: number }>;
  /** 逐件码放明细。 */
  items: PalletItemPlacement[];
  /** 含托总高（托盘高 + 码放高度），mm。 */
  totalHeightMm: number;
  /** 含托总重（自重 + 货物重），g。 */
  totalWeightG: number;
  /** 该托使用的层数。 */
  layerCount: number;
  /** 空间利用率（货物体积 / 托盘可码放体积），0~1。 */
  utilization: number;
}

/** 托盘码放求解结果。 */
export interface PalletPlanResult {
  /** 生成的托盘载荷列表（按生成顺序）。 */
  pallets: PalletLoadUnit[];
  /** 未能码上任意托盘的产品 SKU 明细。 */
  unloaded: UnloadedItem[];
  /** 汇总：使用托盘数、体积/重量利用率。 */
  metrics: {
    palletsUsed: number;
    totalVolumeMm3: number;
    volumeRatio: number;
    totalWeightG: number;
    weightRatio: number;
    /** 各托盘类型的使用数量统计。 */
    palletsByType: Array<{ palletTypeId: string; used: number }>;
  };
  warnings: string[];
  solverVersion: string;
}
