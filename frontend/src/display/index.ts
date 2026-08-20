// src/display/index.ts
// Public surface of the display module.

export { SelfCorrectingClock } from "./clock";
export { buildFrame, adaptiveWindow } from "./renderer";
export { SpeedReader } from "./SpeedReader";
export { measureTextWidth, layoutLine, centerTranslate, totalWidth, fitFontSize } from "./pretext-layout";
export * from "./types";
