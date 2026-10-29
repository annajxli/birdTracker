import test from "node:test";
import assert from "node:assert/strict";
import {sizeText} from "../src/components/species-size.js";

test("shows the middle of the length range in cm and inches, and mass", () => {
  assert.equal(sizeText({length_cm: [23, 28], mass_g: 77.3}), "Length 26 cm (10 in) · Mass 77 g");
});

test("keeps a decimal for tiny birds and switches to kg for big ones", () => {
  assert.equal(sizeText({mass_g: 3.66}), "Mass 3.7 g");
  assert.equal(sizeText({mass_g: 4130}), "Mass 4.1 kg");
});

test("is empty when nothing is known", () => {
  assert.equal(sizeText({}), "");
  assert.equal(sizeText(), "");
});
