import { solveForBrowser, type BrowserSolveInput, type BrowserSolveResult } from "./browser-solver.js";
import { CargoViewer, type CargoViewerData } from "./viewer/cargo-viewer.js";

const host = document.querySelector<HTMLElement>("#scene");
if (!host) throw new Error("缺少 #scene 三维视图容器");

const viewer = new CargoViewer(host);

declare global {
  interface Window {
    cargoViewer: {
      render(data: CargoViewerData): ReturnType<CargoViewer["setData"]>;
      setView(view: "3d" | "top" | "side"): void;
    };
    cargoSolver: {
      solve(input: BrowserSolveInput): BrowserSolveResult;
    };
  }
}

window.cargoViewer = {
  render: (data) => viewer.setData(data),
  setView: (view) => viewer.setView(view),
};

window.cargoSolver = {
  solve: solveForBrowser,
};

document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    viewer.setView(button.dataset.view as "3d" | "top" | "side");
  });
});
