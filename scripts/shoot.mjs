import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const base = "file://" + path.join(root, "checkin.html");

const states = ["checked_in", "already", "not_found"];
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },     // iPhone-ish
  deviceScaleFactor: 2,
});
for (const s of states) {
  const page = await ctx.newPage();
  await page.goto(`${base}?demo=${s}&instant=1`);
  // let fonts + reveal animation settle
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(root, `scripts/preview_${s}.png`) });
  await page.close();
  console.log("shot", s);
}
await browser.close();
