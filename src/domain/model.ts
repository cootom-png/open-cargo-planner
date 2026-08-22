export const MINIMUM_PALLET_GAP_MM = 50;

export type PalletPolicy = "required" | "forbidden" | "auto";
export type LoadMode = "loose" | "pallet" | "mixed";
export type AllocationStrategy =
  | "LARGE_FIRST"
  | "PROPORTIONAL"
  | "PRIORITY"
  | "COMPLETE_SKU"
  | "MAX_PIECES"
  | "MINIMUM_LOCKED";

export type OrientationCode =
  | "LWH"
  | "WLH"
  | "LHW"
  | "HLW"
  | "WHL"
  | "HWL"
  | "LWH_INVERTED"
  | "WLH_INVERTED"
  | "LHW_INVERTED"
  | "HLW_INVERTED"
  | "WHL_INVERTED"
  | "HWL_INVERTED";

export interface DimensionsMm {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface Orientation extends DimensionsMm {
  code: OrientationCode;
  sideLoaded: boolean;
  upsideDown: boolean;
}

export interface ProductType extends DimensionsMm {
  id: string;
  sku: string;
  name: string;
  weightG: number;
  quantity: number;
  allowHorizontalRotation: boolean;
  allowSideLoading: boolean;
  allowUpsideDown: boolean;
  allowedOrientations?: OrientationCode[];
  mustStayUpright: boolean;
  stackable: boolean;
  maxTopLoadG?: number;
  maxStackLayers?: number;
  palletPolicy: PalletPolicy;
  eligiblePalletTypeIds?: string[];
  priority: number;
}

export interface PalletType extends DimensionsMm {
  id: string;
  code: string;
  name: string;
  supplyMode: "unlimited";
  unitCost?: number;
  emptyWeightG?: number;
  maxLoadG: number;
  maxLoadedHeightMm: number;
  overhangMm: 0;
  allowHorizontalRotation: boolean;
  allowDoubleStack: false;
  minimumGapMm: number;
}

export interface ContainerType {
  id: string;
  code: string;
  name: string;
  innerLengthMm: number;
  innerWidthMm: number;
  innerHeightMm: number;
  doorWidthMm: number;
  doorHeightMm: number;
  maxPayloadG: number;
  quantity: number;
  cost?: number;
}

export interface PlanInput {
  id: string;
  mode: LoadMode;
  allocationStrategy: AllocationStrategy;
  products: ProductType[];
  palletTypes: PalletType[];
  containerTypes: ContainerType[];
  minimumSupportRatio: number;
}
