#!/usr/bin/env node
// Fail-closed static gate. Requires operator-supplied actual production binding inventory.
import { readFileSync } from "node:fs";
const [stagingPath, productionInventoryPath] = process.argv.slice(2);
if (!stagingPath || !productionInventoryPath) {
  console.error("Usage: node scripts/verify-mediaops-staging.mjs <filled-staging-toml> <production-inventory.json>");
  process.exit(2);
}
const config = readFileSync(stagingPath, "utf8");
const production = JSON.parse(readFileSync(productionInventoryPath, "utf8"));
const read = (key) => {
  const matches = [...config.matchAll(new RegExp("^" + key + "\\s*=\\s*\"([^\"]+)\"", "gm"))];
  if (matches.length !== 1) throw new Error("Expected exactly one " + key);
  return matches[0][1];
};
const staging = {
  workerName: read("name"),
  d1Name: read("database_name"),
  d1Id: read("database_id"),
  r2Name: read("bucket_name"),
  r2PreviewName: read("preview_bucket_name"),
};
for (const key of Object.keys(staging)) {
  if (!production[key] || typeof production[key] !== "string") throw new Error("Missing actual production inventory: " + key);
  if (!staging[key] || /REPLACE|PLACEHOLDER|00000000-0000/i.test(staging[key])) throw new Error("Unfilled staging value: " + key);
}
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(staging.d1Id)) throw new Error("Invalid staging D1 UUID");
if (!config.includes('binding = "DB"') || !config.includes('binding = "RESOURCES"')) throw new Error("Required binding missing");
for (const [stagingKey, productionKey] of [["workerName","workerName"],["d1Name","d1Name"],["d1Id","d1Id"],["r2Name","r2Name"],["r2PreviewName","r2PreviewName"]]) {
  if (staging[stagingKey] === production[productionKey]) throw new Error("Production collision: " + stagingKey);
}
if (new Set([staging.r2Name, staging.r2PreviewName, production.r2Name, production.r2PreviewName]).size !== 4) throw new Error("R2 bucket collision");
if (!staging.workerName.includes("staging") || !staging.d1Name.includes("staging") || !staging.r2Name.includes("staging")) throw new Error("Staging names required");
console.log("Staging binding names and IDs are distinct from the supplied production inventory.");
