import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "assets");
const sourceSvg = path.join(assets, "pi-logo-on-light.svg");

function createIco(pngData) {
  // Windows ICO 可以直接包含 PNG 数据，保持图标边缘清晰。
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngData.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngData]);
}

async function writeIcon(name, svgContent) {
  const svgPath = path.join(assets, `${name}.svg`);
  const pngPath = path.join(assets, `${name}.png`);
  const icoPath = path.join(assets, `${name}.ico`);
  const pngData = await sharp(Buffer.from(svgContent)).resize(256, 256).png().toBuffer();
  await Promise.all([
    fs.writeFile(svgPath, svgContent),
    fs.writeFile(pngPath, pngData),
    fs.writeFile(icoPath, createIco(pngData)),
  ]);
}

await fs.mkdir(assets, { recursive: true });
const lightSvg = await fs.readFile(sourceSvg, "utf8");
const darkSvg = lightSvg.replaceAll("#09090b", "#ffffff");
const adaptiveSvg = darkSvg.replace(
  /(<svg[^>]*>)/,
  '$1\n  <rect x="56" y="56" width="688" height="688" rx="150" fill="#18181b" stroke="#3f3f46" stroke-width="20"/>',
);

await Promise.all([
  writeIcon("pi-logo-on-light", lightSvg),
  writeIcon("pi-logo-on-dark", darkSvg),
  writeIcon("pi-logo-adaptive", adaptiveSvg),
]);

const build = path.join(root, "build");
await fs.mkdir(build, { recursive: true });
await Promise.all([
  fs.copyFile(path.join(root, "src", "startup.html"), path.join(build, "startup.html")),
  fs.copyFile(path.join(root, "src", "startup-renderer.js"), path.join(build, "startup-renderer.js")),
  fs.copyFile(path.join(root, "src", "error.html"), path.join(build, "error.html")),
  fs.copyFile(path.join(root, "src", "error-renderer.js"), path.join(build, "error-renderer.js")),
  // Box 设置窗口与用量统计窗口的交互脚本由主进程读入后内联到动态页面，
  // 需要一并复制到 build。
  fs.copyFile(path.join(root, "src", "settings-renderer.js"), path.join(build, "settings-renderer.js")),
  fs.copyFile(path.join(root, "src", "usage-renderer.js"), path.join(build, "usage-renderer.js")),
]);
console.log(`Prepared adaptive theme icons and copied static pages to ${path.relative(root, build)}`);
