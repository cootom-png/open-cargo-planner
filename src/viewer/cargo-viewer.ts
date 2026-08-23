import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  legacyPalletToSceneItem,
  legacyPlacementToSceneItem,
  type LegacyPlacement,
  type SceneItem,
  type SceneProduct,
} from "./scene-items.js";

const MM_TO_WORLD = 0.001;
export const MAX_RENDER_ITEMS = 600;

export interface ContainerDimensions {
  l: number;
  w: number;
  h: number;
}

export interface LegacyPlan {
  placements: LegacyPlacement[];
  pallets: Array<Omit<LegacyPlacement, "pi">>;
}

export interface CargoViewerData {
  container: ContainerDimensions;
  containerCount: number;
  plan: LegacyPlan;
  products: SceneProduct[];
  sceneItems?: SceneItem[];
}

function formatItem(item: SceneItem): string {
  const d = item.dimensionsMm;
  const p = item.originMm;
  return `<strong>${item.sku}</strong><br>实际尺寸：${d.length} × ${d.width} × ${d.height} mm<br>坐标：(${p.x}, ${p.y}, ${p.z}) mm<br>朝向：${item.orientation}`;
}

export class CargoViewer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly content = new THREE.Group();
  private readonly interactive: THREE.Mesh[] = [];
  private readonly tooltip: HTMLDivElement;
  private readonly selection: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private selected: THREE.Mesh | null = null;
  private hovered: THREE.Mesh | null = null;
  private container = { l: 12032, w: 2352, h: 2698 };
  private containerCount = 1;
  private frameHandle = 0;

  constructor(private readonly host: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "cargo-canvas";
    this.host.append(this.renderer.domElement);

    this.tooltip = document.createElement("div");
    this.tooltip.className = "cargo-tooltip hidden";
    this.selection = document.createElement("div");
    this.selection.className = "cargo-selection hidden";
    this.host.append(this.tooltip, this.selection);

    this.scene.background = new THREE.Color(0xf4f7fa);
    this.scene.add(this.content);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7580, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 3.2);
    sun.position.set(7, 12, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 80;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
    this.renderer.domElement.addEventListener("click", this.onClick);
    this.renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.resize();
    this.setView("3d");
    this.animate();
  }

  setData(data: CargoViewerData): { rendered: number; total: number; limited: boolean } {
    this.clearContent();
    this.container = data.container;
    this.containerCount = Math.max(1, data.containerCount);
    const cargoItems = data.sceneItems ?? data.plan.placements.map((placement, index) =>
      legacyPlacementToSceneItem(placement, data.products[placement.pi] ?? { sku: "未知 SKU", color: "#8794a1" }, index),
    );
    const palletItems = data.sceneItems ? [] : data.plan.pallets.map(legacyPalletToSceneItem);
    const visibleCargo = cargoItems.slice(0, MAX_RENDER_ITEMS);
    const items = [...palletItems, ...visibleCargo];

    for (let ci = 0; ci < this.containerCount; ci += 1) this.addContainer(ci);
    for (const item of items) this.addItem(item);
    this.addGround();
    this.setView("3d");
    return { rendered: visibleCargo.length, total: cargoItems.length, limited: visibleCargo.length < cargoItems.length };
  }

  setView(view: "3d" | "top" | "side"): void {
    const l = this.container.l * MM_TO_WORLD;
    const w = this.container.w * MM_TO_WORLD;
    const h = this.container.h * MM_TO_WORLD;
    const totalW = this.containerCount * w + Math.max(0, this.containerCount - 1) * 0.8;
    const target = new THREE.Vector3(l / 2, h / 2, totalW / 2 - w / 2);
    this.controls.target.copy(target);
    if (view === "top") this.camera.position.set(target.x, Math.max(l, totalW) * 1.25, target.z + 0.001);
    else if (view === "side") this.camera.position.set(target.x, target.y, target.z + Math.max(l, h) * 1.15);
    else this.camera.position.set(l * 0.72, Math.max(h * 2.4, 6), totalW + Math.max(w * 2.3, 5));
    this.camera.near = 0.01;
    this.camera.far = 200;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private addContainer(index: number): void {
    const l = this.container.l * MM_TO_WORLD;
    const w = this.container.w * MM_TO_WORLD;
    const h = this.container.h * MM_TO_WORLD;
    const offset = this.containerOffset(index);
    const geometry = new THREE.BoxGeometry(l, h, w);
    const shell = new THREE.Mesh(
      geometry,
      new THREE.MeshPhysicalMaterial({ color: 0x8db2cd, transparent: true, opacity: 0.075, roughness: 0.75, side: THREE.DoubleSide, depthWrite: false }),
    );
    shell.position.set(l / 2, h / 2, offset + w / 2);
    this.content.add(shell);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x41647d }));
    edges.position.copy(shell.position);
    this.content.add(edges);
  }

  private addItem(item: SceneItem): void {
    const d = item.dimensionsMm;
    const geometry = new THREE.BoxGeometry(d.length * MM_TO_WORLD, d.height * MM_TO_WORLD, d.width * MM_TO_WORLD);
    const material = new THREE.MeshStandardMaterial({
      color: item.color,
      roughness: item.kind === "pallet" ? 0.9 : 0.62,
      metalness: 0.02,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(item.centerMm.x * MM_TO_WORLD, item.centerMm.z * MM_TO_WORLD, this.containerOffset(item.containerIndex) + item.centerMm.y * MM_TO_WORLD);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.sceneItem = item;
    this.content.add(mesh);
    this.interactive.push(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: item.kind === "pallet" ? 0x614326 : 0x263848, transparent: true, opacity: 0.72 }));
    edges.position.copy(mesh.position);
    this.content.add(edges);
  }

  private addGround(): void {
    const l = this.container.l * MM_TO_WORLD;
    const w = this.container.w * MM_TO_WORLD;
    const totalW = this.containerCount * w + Math.max(0, this.containerCount - 1) * 0.8;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(l + 2, totalW + 2), new THREE.MeshStandardMaterial({ color: 0xdce3e8, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(l / 2, -0.015, totalW / 2 - w / 2);
    ground.receiveShadow = true;
    this.content.add(ground);
  }

  private containerOffset(index: number): number {
    return index * (this.container.w * MM_TO_WORLD + 0.8);
  }

  private pick(event: PointerEvent): THREE.Mesh | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return (this.raycaster.intersectObjects(this.interactive, false)[0]?.object as THREE.Mesh | undefined) ?? null;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const mesh = this.pick(event);
    if (mesh !== this.hovered) {
      this.setEmissive(this.hovered, 0x000000);
      this.hovered = mesh;
      if (mesh !== this.selected) this.setEmissive(mesh, 0x253647);
    }
    if (!mesh) {
      this.tooltip.classList.add("hidden");
      return;
    }
    this.tooltip.innerHTML = formatItem(mesh.userData.sceneItem as SceneItem);
    this.tooltip.style.left = `${event.offsetX + 14}px`;
    this.tooltip.style.top = `${event.offsetY + 14}px`;
    this.tooltip.classList.remove("hidden");
  };

  private readonly onPointerLeave = (): void => {
    if (this.hovered !== this.selected) this.setEmissive(this.hovered, 0x000000);
    this.hovered = null;
    this.tooltip.classList.add("hidden");
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (this.selected) this.setEmissive(this.selected, 0x000000);
    this.selected = this.pick(event as PointerEvent);
    if (!this.selected) {
      this.selection.classList.add("hidden");
      return;
    }
    this.setEmissive(this.selected, 0x5f4d17);
    this.selection.innerHTML = `<span>已选中</span>${formatItem(this.selected.userData.sceneItem as SceneItem)}`;
    this.selection.classList.remove("hidden");
  };

  private setEmissive(mesh: THREE.Mesh | null, color: number): void {
    const material = mesh?.material;
    if (material instanceof THREE.MeshStandardMaterial) material.emissive.setHex(color);
  }

  private clearContent(): void {
    this.selected = null;
    this.hovered = null;
    this.selection.classList.add("hidden");
    this.tooltip.classList.add("hidden");
    this.interactive.length = 0;
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      const renderable = child as THREE.Mesh | THREE.LineSegments;
      renderable.geometry?.dispose();
      const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      materials.forEach((material) => material?.dispose());
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.observer.disconnect();
    this.controls.dispose();
    this.clearContent();
    this.renderer.dispose();
  }
}
