import assert from "node:assert/strict";
import { test } from "node:test";
import { byVersion, changelogBetween } from "../../probe/changelog.ts";

// Synthetic entries in the changelog's format (`## <version>`, newest first, `- ` bullets).
const TEXT = [
  "# Changelog",
  "",
  "## 2.1.310",
  "",
  "- Added the alpha option",
  "- [VSCode] Fixed the beta panel",
  "",
  "## 2.1.300",
  "",
  "- Windows: fixed the gamma path",
  "",
  "## 2.1.99",
  "",
  "- Changed the delta default",
  "",
  "## 2.1.98",
  "",
  "- Removed the epsilon flag",
  "",
].join("\n");

test("versions order by number, not by text", () => {
  assert.ok(byVersion("2.1.99", "2.1.300") < 0);
  assert.ok(byVersion("2.1.300", "2.1.99") > 0);
  assert.equal(byVersion("2.1.3", "2.1.3"), 0);
});

test("the range excludes the baseline, includes the tested version and keeps every bullet", () => {
  const found = changelogBetween(TEXT, "2.1.99", "2.1.310");
  assert.ok(found.includes("## 2.1.310"));
  assert.ok(found.includes("## 2.1.300"));
  assert.ok(!found.includes("## 2.1.99"));
  assert.ok(!found.includes("delta"));
  assert.ok(found.includes("- [VSCode] Fixed the beta panel"));
  assert.ok(found.includes("- Windows: fixed the gamma path"));
  // Newest first, whatever order the file lists them in.
  assert.ok(found.indexOf("## 2.1.310") < found.indexOf("## 2.1.300"));
  // The tested version is the upper bound: a newer section stays out.
  const capped = changelogBetween(TEXT, "2.1.98", "2.1.300");
  assert.ok(!capped.includes("## 2.1.310"));
  assert.ok(capped.includes("## 2.1.99") && capped.includes("## 2.1.300"));
});

test("2.1.99 sits below 2.1.300", () => {
  const found = changelogBetween(TEXT, "2.1.98", "2.1.99");
  assert.ok(found.includes("delta"));
  assert.ok(!found.includes("gamma"));
});

test("an empty range says so", () => {
  const found = changelogBetween(TEXT, "2.1.310", "2.1.310");
  assert.match(found, /No section in that range\./);
  assert.ok(!found.includes("alpha"));
});

test("a tested version the changelog does not list yet is named, with the sections below it", () => {
  const found = changelogBetween(TEXT, "2.1.99", "2.1.311");
  assert.match(found, /2\.1\.311 is not in the changelog yet\./);
  assert.ok(found.includes("## 2.1.310"));
  assert.match(changelogBetween("# Changelog\n", "2.1.1", "2.1.2"), /No section in that range/);
});

test("a heading with words after its version is still that version's section", () => {
  const text = "# Changelog\n\n## 2.1.311 (2026-10-26)\n\n- Added a\n\n## 2.1.310\n\n- Fixed b\n";
  const out = changelogBetween(text, "2.1.310", "2.1.311");
  assert.match(out, /Added a/);
  assert.doesNotMatch(out, /Fixed b/);
  assert.doesNotMatch(out, /not in the changelog/);
});
