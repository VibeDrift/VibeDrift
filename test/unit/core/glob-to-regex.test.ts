import { describe, it, expect } from "vitest";
import { globToRegex } from "../../../src/core/file-filter.js";

describe("globToRegex", () => {
  // Regression: '[!abc]' negated character classes silently broke — the
  // leading '!' was escaped and emitted as a literal character instead of
  // being translated to regex's '^' negation, so "[!_]*.ts" matched files
  // starting with a literal '!' or '_' instead of excluding underscore-led
  // ones.
  it("translates a leading '!' in a character class to regex negation", () => {
    const re = globToRegex("[!_]*.ts");
    // "not an underscore" — matches anything else, including a literal '!'.
    expect(re.test("bar.ts")).toBe(true);
    expect(re.test("!foo.ts")).toBe(true);
    // The one thing it must exclude: files starting with the negated char.
    expect(re.test("_foo.ts")).toBe(false);
  });

  it("still supports a leading '^' (already regex-native negation)", () => {
    const re = globToRegex("[^_]*.ts");
    expect(re.test("bar.ts")).toBe(true);
    expect(re.test("_foo.ts")).toBe(false);
  });

  it("keeps a normal (non-negated) character class matching literally", () => {
    const re = globToRegex("[ab]*.ts");
    expect(re.test("app.ts")).toBe(true);
    expect(re.test("box.ts")).toBe(true); // 'b' matches
    expect(re.test("cow.ts")).toBe(false);
  });

  it("a '!' NOT at the start of a class stays literal", () => {
    const re = globToRegex("[a!]*.ts");
    expect(re.test("!oo.ts")).toBe(true);
    expect(re.test("aoo.ts")).toBe(true);
    expect(re.test("boo.ts")).toBe(false);
  });
});
